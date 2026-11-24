using System.Buffers.Text;
using System.Globalization;
using System.Text;
using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Domain.Fx;
using Kitty.Ledger.Domain.Splits;
using Kitty.Ledger.Features.Fx;
using Kitty.Ledger.Features.Groups;
using Kitty.Ledger.Features.Notifications;
using Kitty.Ledger.Infrastructure;
using Kitty.Ledger.Infrastructure.Audit;
using Kitty.Ledger.Infrastructure.Errors;
using Microsoft.EntityFrameworkCore;
using Kitty.Contracts.Events.V1;
using Kitty.Ledger.Infrastructure.Messaging;

namespace Kitty.Ledger.Features.Expenses;

public static class ExpenseEndpoints
{
    public const string EntityType = "expense";
    public const int DefaultPageSize = 30;
    public const int MaxPageSize = 100;

    public static void MapExpenses(this RouteGroupBuilder group)
    {
        var expenses = group.MapGroup("/expenses").WithTags("Expenses");
        expenses.MapPost("/", CreateAsync).WithName("CreateExpense").Produces<ExpenseDto>(StatusCodes.Status201Created);
        expenses.MapGet("/", ListAsync).WithName("ListExpenses").Produces<ExpensePageDto>();
        expenses.MapGet("/{expenseId:guid}", GetAsync).WithName("GetExpense").Produces<ExpenseDto>();
        expenses.MapPut("/{expenseId:guid}", UpdateAsync).WithName("UpdateExpense").Produces<ExpenseDto>();
        expenses.MapDelete("/{expenseId:guid}", DeleteAsync).WithName("DeleteExpense").Produces(StatusCodes.Status204NoContent);
    }

    private static async Task<IResult> CreateAsync(Guid groupId, ExpenseWriteDto body, HttpContext http, LedgerDbContext db,
        AuditWriter audit, Outbox outbox, ExpenseRates rates, Notifier notifier, TimeProvider clock, CancellationToken ct)
    {
        var caller = GroupMemberFilter.CallerMember(http);
        var validation = await ValidateAsync(groupId, body, db, ct);
        if (validation is not ExpenseValidation.Valid valid) return Invalid(validation);
        if (await db.Expenses.AnyAsync(x => x.Id == body.Id, ct)) return ApiError.Conflict(ErrorCodes.AlreadyExists);

        var expense = NewExpense(groupId, body, valid.Shares, caller.User.Id, clock.NowMicros());
        var groupCurrency = await GroupCurrencyAsync(db, groupId, ct);
        var decision = await rates.DecideAsync(expense.Currency, groupCurrency, expense.OccurredOn, body.FxRate, null, ct);
        if (ApplyRate(expense, decision, groupCurrency) is { } rateError) return rateError;
        db.Expenses.Add(expense);

        var dto = expense.ToDto();
        audit.Record(caller.User.Id, groupId, EntityType, expense.Id, AuditActions.Created, null, dto);
        outbox.ExpenseChanged(groupId, expense.Id, ExpenseChanged.Types.Change.Created);
        await notifier.ExpenseAddedAsync(expense, caller.User.Id, ct);
        await db.SaveChangesAsync(ct);
        return Results.Created($"/groups/{groupId}/expenses/{expense.Id}", dto);
    }

    private static async Task<IResult> GetAsync(Guid groupId, Guid expenseId, LedgerDbContext db, CancellationToken ct)
    {
        var expense = await db.Expenses.AsNoTracking()
            .SingleOrDefaultAsync(x => x.Id == expenseId && x.GroupId == groupId && x.DeletedAt == null, ct);
        return expense is null ? ApiError.NotFound() : Results.Ok(expense.ToDto());
    }

    private static async Task<IResult> UpdateAsync(Guid groupId, Guid expenseId, ExpenseWriteDto body, HttpContext http,
        LedgerDbContext db, AuditWriter audit, Outbox outbox, ExpenseRates rates, TimeProvider clock, CancellationToken ct)
    {
        var caller = GroupMemberFilter.CallerMember(http);
        var expense = await db.Expenses.SingleOrDefaultAsync(x => x.Id == expenseId && x.GroupId == groupId && x.DeletedAt == null, ct);
        if (expense is null) return ApiError.NotFound();
        if (expense.SplitMethod == SplitMethod.Itemized)
            return ApiError.Conflict(ErrorCodes.EditInTable, "This expense was split at the table. Delete it and split the bill again.");
        if (body.Version is null) return ApiError.Validation("version is required when updating an expense.");
        if (body.Version != expense.Version) return VersionConflict();

        var validation = await ValidateAsync(groupId, body with { Id = expenseId }, db, ct);
        if (validation is not ExpenseValidation.Valid valid) return Invalid(validation);

        var groupCurrency = await GroupCurrencyAsync(db, groupId, ct);
        // Decided against the expense as stored: an unchanged currency and date keep their rate.
        var decision = await rates.DecideAsync(body.Currency, groupCurrency, body.OccurredOn, body.FxRate, expense, ct);

        var before = expense.ToDto();
        // The concurrency token check compares against the version the client saw.
        db.Entry(expense).Property(x => x.Version).OriginalValue = body.Version.Value;
        expense.Description = body.Description.Trim();
        expense.Category = body.Category;
        expense.Currency = body.Currency;
        expense.AmountMinor = body.AmountMinor;
        expense.OccurredOn = body.OccurredOn;
        expense.SplitMethod = body.Split.Method;
        expense.Version = body.Version.Value + 1;
        expense.UpdatedAt = clock.NowMicros();
        expense.Payers.Clear();
        expense.Shares.Clear();
        Apply(expense, body, valid.Shares);
        if (ApplyRate(expense, decision, groupCurrency) is { } rateError) return rateError;

        var dto = expense.ToDto();
        audit.Record(caller.User.Id, groupId, EntityType, expense.Id, AuditActions.Updated, before, dto);
        outbox.ExpenseChanged(groupId, expense.Id, ExpenseChanged.Types.Change.Updated);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            return VersionConflict();
        }
        return Results.Ok(dto);
    }

    private static async Task<IResult> DeleteAsync(Guid groupId, Guid expenseId, HttpContext http, LedgerDbContext db,
        AuditWriter audit, Outbox outbox, TimeProvider clock, CancellationToken ct)
    {
        var caller = GroupMemberFilter.CallerMember(http);
        var expense = await db.Expenses.SingleOrDefaultAsync(x => x.Id == expenseId && x.GroupId == groupId && x.DeletedAt == null, ct);
        if (expense is null) return ApiError.NotFound();

        var before = expense.ToDto();
        expense.DeletedAt = clock.NowMicros();
        audit.Record(caller.User.Id, groupId, EntityType, expense.Id, AuditActions.Deleted, before, null);
        outbox.ExpenseChanged(groupId, expense.Id, ExpenseChanged.Types.Change.Deleted);
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static async Task<IResult> ListAsync(Guid groupId, LedgerDbContext db, CancellationToken ct, string? cursor = null, int? limit = null)
    {
        var size = limit ?? DefaultPageSize;
        if (size is < 1 or > MaxPageSize) return ApiError.Validation($"limit must be between 1 and {MaxPageSize}.");

        var query = db.Expenses.AsNoTracking().Where(x => x.GroupId == groupId && x.DeletedAt == null);
        if (cursor is not null)
        {
            if (!TryDecodeCursor(cursor, out var on, out var at, out var id)) return ApiError.Validation("cursor is not valid.");
            // Keyset: rows strictly after the cursor in (occurredOn, createdAt, id) descending order,
            // as a Postgres row-value comparison: (a, b, c) < (x, y, z).
            query = query.Where(x => EF.Functions.LessThan(
                ValueTuple.Create(x.OccurredOn, x.CreatedAt, x.Id), ValueTuple.Create(on, at, id)));
        }

        var rows = await query
            .OrderByDescending(x => x.OccurredOn).ThenByDescending(x => x.CreatedAt).ThenByDescending(x => x.Id)
            .Take(size + 1)
            .ToListAsync(ct);

        var page = rows.Take(size).ToList();
        var next = rows.Count > size ? EncodeCursor(page[^1]) : null;
        return Results.Ok(new ExpensePageDto(page.Select(e => e.ToDto()).ToList(), next));
    }

    private static async Task<ExpenseValidation> ValidateAsync(Guid groupId, ExpenseWriteDto body, LedgerDbContext db, CancellationToken ct)
    {
        var memberIds = await db.Members.Where(m => m.GroupId == groupId).Select(m => m.Id).ToListAsync(ct);
        return ExpenseValidator.Validate(body, memberIds.ToHashSet());
    }

    private static IResult Invalid(ExpenseValidation validation) =>
        validation is ExpenseValidation.Invalid invalid
            ? ApiError.BadRequest(invalid.Code, invalid.Detail)
            : throw new InvalidOperationException("Expected an invalid result.");

    private static IResult VersionConflict() =>
        ApiError.Conflict(ErrorCodes.VersionConflict, "Someone else changed this expense. Reload to see their version.");

    private static void Apply(Expense expense, ExpenseWriteDto body, IReadOnlyList<Share> shares)
    {
        var inputs = body.Split.Participants.ToDictionary(p => p.MemberId, p => p.Value);
        expense.Payers.AddRange(body.Payers.Select(p => new ExpensePayer { MemberId = p.MemberId, AmountMinor = p.AmountMinor }));
        expense.Shares.AddRange(shares.Select(s => new ExpenseShare
        {
            MemberId = s.MemberId,
            AmountMinor = s.Minor,
            InputValue = body.Split.Method == SplitMethod.Equal ? null : inputs[s.MemberId],
        }));
    }

    internal static async Task<string> GroupCurrencyAsync(LedgerDbContext db, Guid groupId, CancellationToken ct) =>
        (await db.Groups.Where(g => g.Id == groupId).Select(g => g.BaseCurrency).SingleAsync(ct)).Trim();

    /// <summary>Stores the decided rate and the converted amount on the expense, or returns the error to send.</summary>
    /// <summary>A new expense from a validated write (shares computed by the validator).</summary>
    internal static Expense NewExpense(Guid groupId, ExpenseWriteDto body, IReadOnlyList<Share> shares, Guid createdBy, DateTimeOffset now)
    {
        var expense = new Expense
        {
            Id = body.Id, GroupId = groupId, Description = body.Description.Trim(), Category = body.Category,
            Currency = body.Currency, AmountMinor = body.AmountMinor, OccurredOn = body.OccurredOn,
            SplitMethod = body.Split.Method, Version = 1, CreatedByUserId = createdBy, CreatedAt = now, UpdatedAt = now,
        };
        Apply(expense, body, shares);
        return expense;
    }

    /// <param name="withoutRateIfTooLarge">Save without a rate instead of rejecting when the converted amount is too large
    /// (recurring periods: nobody is there to fix it, and a period must not vanish).</param>
    internal static IResult? ApplyRate(Expense expense, RateDecision decision, string groupCurrency, bool withoutRateIfTooLarge = false)
    {
        switch (decision)
        {
            case RateDecision.Invalid invalid:
                return ApiError.BadRequest(ErrorCodes.FxRateInvalid, invalid.Detail);
            case RateDecision.Rate rate:
                var converted = FxConverter.Convert(expense.AmountMinor, rate.Value, expense.Currency.Trim(), groupCurrency);
                if (converted > SplitCalculator.MaxTotalMinor)
                {
                    if (!withoutRateIfTooLarge) return ApiError.BadRequest(ErrorCodes.FxRateInvalid, "Converted amount is too large.");
                    goto default;
                }
                (expense.FxRate, expense.FxRateDate, expense.FxRateSource, expense.ConvertedAmountMinor) =
                    (rate.Value, rate.EcbDate, rate.Source, converted);
                return null;
            default: // None, or Missing: saved without a rate (spec: never blocked by pulse being down)
                (expense.FxRate, expense.FxRateDate, expense.FxRateSource, expense.ConvertedAmountMinor) = (null, null, null, null);
                return null;
        }
    }

    private static string EncodeCursor(Expense e) =>
        Base64Url.EncodeToString(Encoding.UTF8.GetBytes(
            $"{e.OccurredOn:yyyy-MM-dd}|{e.CreatedAt.UtcTicks}|{e.Id:D}"));

    private static bool TryDecodeCursor(string cursor, out DateOnly on, out DateTimeOffset at, out Guid id)
    {
        on = default; at = default; id = default;
        try
        {
            var parts = Encoding.UTF8.GetString(Base64Url.DecodeFromChars(cursor)).Split('|');
            if (parts.Length != 3
                || !DateOnly.TryParseExact(parts[0], "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out on)
                || !long.TryParse(parts[1], CultureInfo.InvariantCulture, out var ticks)
                || !Guid.TryParse(parts[2], out id))
                return false;
            at = new DateTimeOffset(ticks, TimeSpan.Zero);
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
    }
}
