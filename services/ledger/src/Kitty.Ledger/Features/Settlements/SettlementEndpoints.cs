using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Domain;
using Kitty.Ledger.Domain.Fx;
using Kitty.Ledger.Domain.Splits;
using Kitty.Ledger.Features.Common;
using Kitty.Ledger.Features.Expenses;
using Kitty.Ledger.Features.Fx;
using Kitty.Ledger.Features.Notifications;
using Kitty.Ledger.Infrastructure.Fx;
using Kitty.Ledger.Features.Groups;
using Kitty.Ledger.Infrastructure;
using Kitty.Ledger.Infrastructure.Audit;
using Kitty.Ledger.Infrastructure.Errors;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Settlements;

/// <summary>
/// FxRate: typed by a person (omit to use the ECB rate). PaidInGroupCurrency: paid in the group's currency instead.
/// Covers: the expenses this payment pays for, and how much of each (omit for a plain payment).
/// </summary>
public sealed record SettlementWriteDto(Guid Id, Guid FromMemberId, Guid ToMemberId, string Currency, long AmountMinor,
    string? FxRate = null, bool PaidInGroupCurrency = false, IReadOnlyList<CoverDto>? Covers = null);

public sealed record CoverDto(Guid ExpenseId, long AmountMinor);

public sealed record SettlementDto(Guid Id, Guid FromMemberId, Guid ToMemberId, string Currency, long AmountMinor,
    Guid CreatedBy, DateTimeOffset CreatedAt, string? FxRate, DateOnly? FxRateDate, string? FxRateSource,
    long? ConvertedAmountMinor, bool PaidInGroupCurrency, IReadOnlyList<CoverDto> Covers);

public sealed record CoverLineDto(Guid ExpenseId, string Description, MoneyDto Amount);

public sealed record SettlementLineDto(SettlementDto Payment, string From, string To, DateOnly Date, IReadOnlyList<CoverLineDto> Covers);

/// <summary>"From paid To back" — recorded by either party (or anyone in the group) when money changed hands outside Kitty.</summary>
public static class SettlementEndpoints
{
    public const string EntityType = "settlement";
    private const int DefaultLimit = 20;
    private const int MaxLimit = 50;
    private const string DeletedExpense = "(deleted expense)";
    private static readonly TimeSpan SouthAfrica = TimeSpan.FromHours(2);

    public static void MapSettlements(this RouteGroupBuilder group)
    {
        var settlements = group.MapGroup("/settlements").WithTags("Settlements");
        settlements.MapGet("/", ListAsync).WithName("ListSettlements").Produces<IReadOnlyList<SettlementLineDto>>();
        settlements.MapPost("/", CreateAsync).WithName("CreateSettlement").Produces<SettlementDto>(StatusCodes.Status201Created);
        settlements.MapDelete("/{settlementId:guid}", DeleteAsync).WithName("DeleteSettlement").Produces(StatusCodes.Status204NoContent);
    }

    private static async Task<IResult> CreateAsync(Guid groupId, SettlementWriteDto body, HttpContext http, LedgerDbContext db,
        AuditWriter audit, ExpenseRates rates, IFxRates fx, Notifier notifier, TimeProvider clock, CancellationToken ct)
    {
        if (body.Id == Guid.Empty) return ApiError.Validation("id must be a client-generated UUID.");
        if (body.FromMemberId == body.ToMemberId) return ApiError.Validation("A member cannot settle with themselves.");
        if (body.AmountMinor is < 1 or > SplitCalculator.MaxTotalMinor) return ApiError.Validation("amountMinor must be between 1 and 10,000,000,000.");
        if (!Currencies.IsSupported(body.Currency ?? ""))
            return ApiError.BadRequest(ErrorCodes.CurrencyUnsupported, $"'{body.Currency}' is not a supported currency.");

        var inGroup = await db.Members.CountAsync(m => m.GroupId == groupId && (m.Id == body.FromMemberId || m.Id == body.ToMemberId), ct);
        if (inGroup != 2) return ApiError.BadRequest(ErrorCodes.MemberNotInGroup, "Both members must be in this group.");
        if (await db.Settlements.AnyAsync(s => s.Id == body.Id, ct)) return ApiError.Conflict(ErrorCodes.AlreadyExists);

        var groupCurrency = await ExpenseEndpoints.GroupCurrencyAsync(db, groupId, ct);
        if (body.PaidInGroupCurrency && body.Currency == groupCurrency)
            return ApiError.Validation("Paying in the group's currency only applies to a debt in another currency.");
        // Settlements have no date and can't be edited, so a foreign one always gets today's rate, or one typed in.
        var today = DateOnly.FromDateTime(clock.GetUtcNow().UtcDateTime);
        var decision = await rates.DecideAsync(body.Currency!, groupCurrency, today, body.FxRate, null, ct);
        // Paying in the group's currency sends back the rate the payer saw and confirmed, so the amount stored is the
        // amount paid. When that is still today's ECB rate, say so.
        if (decision is RateDecision.Rate { Source: FxEndpoints.ManualSource } sent
            && await fx.GetAsync(body.Currency!, groupCurrency, today, ct) is { } ecb && ecb.Rate == sent.Value)
            decision = new RateDecision.Rate(sent.Value, ecb.RateDate, FxEndpoints.EcbSource);
        long? converted = null;
        switch (decision)
        {
            case RateDecision.Invalid invalid:
                return ApiError.BadRequest(ErrorCodes.FxRateInvalid, invalid.Detail);
            case RateDecision.Missing:
                return ApiError.Problem(StatusCodes.Status422UnprocessableEntity, ErrorCodes.FxRateRequired,
                    "We couldn't look up the exchange rate. Enter it to record this payment.");
            case RateDecision.Rate r:
                converted = FxConverter.Convert(body.AmountMinor, r.Value, body.Currency!, groupCurrency);
                if (converted > SplitCalculator.MaxTotalMinor) return ApiError.BadRequest(ErrorCodes.FxRateInvalid, "Converted amount is too large.");
                break;
        }
        var rate = decision as RateDecision.Rate;

        var covers = body.Covers ?? [];
        if (covers.Count > 0 && await CoverProblemAsync(db, groupId, body, covers, ct) is { } coverProblem)
            return ApiError.BadRequest(ErrorCodes.CoverInvalid, coverProblem);

        var caller = GroupMemberFilter.CallerMember(http);
        var settlement = new Settlement
        {
            Id = body.Id, GroupId = groupId, FromMemberId = body.FromMemberId, ToMemberId = body.ToMemberId,
            Currency = body.Currency!, AmountMinor = body.AmountMinor, CreatedByUserId = caller.User.Id, CreatedAt = clock.NowMicros(),
            FxRate = rate?.Value, FxRateDate = rate?.EcbDate, FxRateSource = rate?.Source, ConvertedAmountMinor = converted,
            PaidInGroupCurrency = body.PaidInGroupCurrency,
            Covers = covers.Select(c => new SettlementCover { ExpenseId = c.ExpenseId, AmountMinor = c.AmountMinor }).ToList(),
        };
        db.Settlements.Add(settlement);
        await notifier.PaymentAsync(settlement, caller.User.Id, ct);

        var dto = ToDto(settlement);
        audit.Record(caller.User.Id, groupId, EntityType, settlement.Id, AuditActions.Created, null, dto);
        await db.SaveChangesAsync(ct);
        return Results.Created($"/groups/{groupId}/settlements/{settlement.Id}", dto);
    }

    private static async Task<IResult> DeleteAsync(Guid groupId, Guid settlementId, HttpContext http, LedgerDbContext db,
        AuditWriter audit, TimeProvider clock, CancellationToken ct)
    {
        var settlement = await db.Settlements.SingleOrDefaultAsync(s => s.Id == settlementId && s.GroupId == groupId && s.DeletedAt == null, ct);
        if (settlement is null) return ApiError.NotFound();

        var caller = GroupMemberFilter.CallerMember(http);
        settlement.DeletedAt = clock.NowMicros();
        audit.Record(caller.User.Id, groupId, EntityType, settlement.Id, AuditActions.Deleted, ToDto(settlement), null);
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    /// <summary>
    /// Why these covers can't be recorded, or null when they can. No row locking: two payments racing can over-cover an
    /// item, and <see cref="OpenItems.Effective"/> then clamps the later one.
    /// </summary>
    private static async Task<string?> CoverProblemAsync(LedgerDbContext db, Guid groupId, SettlementWriteDto body,
        IReadOnlyList<CoverDto> covers, CancellationToken ct)
    {
        if (covers.Any(c => c is null)) return "Each cover needs an expense and an amount.";
        var expenses = await db.Expenses.AsNoTracking().Where(e => e.GroupId == groupId && e.DeletedAt == null).ToListAsync(ct);
        var byId = expenses.ToDictionary(e => e.Id);
        string Name(Guid id) => byId.TryGetValue(id, out var e) ? $"'{e.Description}'" : "An item";

        if (covers.GroupBy(c => c.ExpenseId).FirstOrDefault(g => g.Count() > 1) is { } twice)
            return $"{Name(twice.Key)} is covered more than once.";
        foreach (var c in covers)
        {
            if (!byId.TryGetValue(c.ExpenseId, out var e)) return "An item this payment covers isn't in this group.";
            if (e.Currency.Trim() != body.Currency)
                return $"'{e.Description}' is in {e.Currency.Trim()}, not {body.Currency}.";
        }

        var settlements = await db.Settlements.AsNoTracking().Where(s => s.GroupId == groupId && s.DeletedAt == null).ToListAsync(ct);
        var open = OpenItems.Between(expenses, settlements, body.Currency, body.FromMemberId, body.ToMemberId)
            .ToDictionary(i => i.Expense.Id, i => i.Open);
        foreach (var c in covers)
        {
            var left = open.GetValueOrDefault(c.ExpenseId);
            if (left == 0) return $"{Name(c.ExpenseId)} has nothing left to pay between these two.";
            if (c.AmountMinor < 1) return $"The cover on {Name(c.ExpenseId)} must be more than nothing.";
            if (c.AmountMinor > left) return $"{Name(c.ExpenseId)} has only {MoneyText.Format(left, body.Currency)} left to pay.";
        }
        if (covers.Sum(c => c.AmountMinor) > body.AmountMinor)
            return "The items this payment covers add up to more than the payment.";
        return null;
    }

    /// <summary>The group's live payments, newest first, each with the expenses it covered (a deleted expense is named as such).</summary>
    private static async Task<IResult> ListAsync(Guid groupId, LedgerDbContext db, CancellationToken ct, int limit = DefaultLimit)
    {
        if (limit is < 1 or > MaxLimit) return ApiError.Validation($"limit must be between 1 and {MaxLimit}.");

        var payments = await db.Settlements.AsNoTracking().Where(s => s.GroupId == groupId && s.DeletedAt == null)
            .OrderByDescending(s => s.CreatedAt).ThenByDescending(s => s.Id).Take(limit).ToListAsync(ct);
        var names = await db.Members.AsNoTracking().Where(m => m.GroupId == groupId).ToDictionaryAsync(m => m.Id, m => m.DisplayName, ct);
        var expenseIds = payments.SelectMany(p => p.Covers).Select(c => c.ExpenseId).Distinct().ToList();
        var descriptions = await db.Expenses.AsNoTracking().Where(e => e.GroupId == groupId && expenseIds.Contains(e.Id))
            .ToDictionaryAsync(e => e.Id, e => e.DeletedAt == null ? e.Description : DeletedExpense, ct);

        var lines = payments.Select(p =>
        {
            var currency = p.Currency.Trim();
            var covers = p.Covers
                .Select(c => new CoverLineDto(c.ExpenseId, descriptions.GetValueOrDefault(c.ExpenseId, DeletedExpense), MoneyDto.Of(c.AmountMinor, currency)))
                .OrderBy(c => c.Description, StringComparer.Ordinal).ThenBy(c => c.ExpenseId).ToList();
            return new SettlementLineDto(ToDto(p), names[p.FromMemberId], names[p.ToMemberId],
                DateOnly.FromDateTime(p.CreatedAt.ToOffset(SouthAfrica).DateTime), covers);
        }).ToList();
        return Results.Ok(lines);
    }

    private static SettlementDto ToDto(Settlement s) =>
        new(s.Id, s.FromMemberId, s.ToMemberId, s.Currency.Trim(), s.AmountMinor, s.CreatedByUserId, s.CreatedAt,
            s.FxRate is { } rate ? Domain.Fx.FxRate.Format(rate) : null, s.FxRateDate, s.FxRateSource, s.ConvertedAmountMinor,
            s.PaidInGroupCurrency, s.Covers.OrderBy(c => c.ExpenseId).Select(c => new CoverDto(c.ExpenseId, c.AmountMinor)).ToList());
}
