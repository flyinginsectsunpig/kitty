using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Domain;
using Kitty.Ledger.Domain.Splits;
using Kitty.Ledger.Features.Expenses;
using Kitty.Ledger.Features.Fx;
using Kitty.Ledger.Features.Groups;
using Kitty.Ledger.Features.Notifications;
using Kitty.Ledger.Features.Scans;
using Kitty.Ledger.Infrastructure;
using Kitty.Ledger.Infrastructure.Audit;
using Kitty.Ledger.Infrastructure.Errors;
using Kitty.Ledger.Infrastructure.Telemetry;
using Kitty.Ledger.Infrastructure.Messaging;
using Kitty.Contracts.Events.V1;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Kitty.Ledger.Features.Table;

public static class TableEndpoints
{
    public const string EntityType = "table_session";
    public const int MaxItems = 100;
    public const int MaxCharges = 10;

    public static void MapTableSessions(this RouteGroupBuilder group)
    {
        var sessions = group.MapGroup("/table-sessions").WithTags("Table");
        sessions.MapGet("/", ListActiveAsync).WithName("ListActiveTableSessions").Produces<IReadOnlyList<ActiveTableDto>>();
        sessions.MapPost("/", CreateAsync).WithName("CreateTableSession").Produces<TableSessionDto>(StatusCodes.Status201Created);
        sessions.MapGet("/{sessionId:guid}", GetAsync).WithName("GetTableSession").Produces<TableSessionDto>();
        sessions.MapPut("/{sessionId:guid}/items", ReplaceItemsAsync).WithName("ReplaceTableItems").Produces<TableSessionDto>();
        sessions.MapPut("/{sessionId:guid}/charges", ReplaceChargesAsync).WithName("ReplaceTableCharges").Produces<TableSessionDto>();
        sessions.MapPut("/{sessionId:guid}/items/{itemId:guid}/claim", (Guid groupId, Guid sessionId, Guid itemId, HttpContext http,
            TableSessionService svc, CancellationToken ct) => ClaimAsync(groupId, sessionId, itemId, true, http, svc, ct)).WithName("ClaimTableItem");
        sessions.MapDelete("/{sessionId:guid}/items/{itemId:guid}/claim", (Guid groupId, Guid sessionId, Guid itemId, HttpContext http,
            TableSessionService svc, CancellationToken ct) => ClaimAsync(groupId, sessionId, itemId, false, http, svc, ct)).WithName("UnclaimTableItem");
        sessions.MapPost("/{sessionId:guid}/lock", (Guid groupId, Guid sessionId, HttpContext http, LedgerDbContext db, TableSessionService svc,
            AuditWriter audit, TimeProvider clock, CancellationToken ct) =>
            TransitionAsync(groupId, sessionId, SessionStatus.Open, SessionStatus.Locked, http, db, svc, audit, clock, ct)).WithName("LockTableSession");
        sessions.MapPost("/{sessionId:guid}/unlock", (Guid groupId, Guid sessionId, HttpContext http, LedgerDbContext db, TableSessionService svc,
            AuditWriter audit, TimeProvider clock, CancellationToken ct) =>
            TransitionAsync(groupId, sessionId, SessionStatus.Locked, SessionStatus.Open, http, db, svc, audit, clock, ct)).WithName("UnlockTableSession");
        sessions.MapPost("/{sessionId:guid}/cancel", CancelAsync).WithName("CancelTableSession").Produces<TableSessionDto>();
        sessions.MapPost("/{sessionId:guid}/guests/{guestId:guid}/map", MapGuestAsync).WithName("MapTableGuest").Produces<TableSessionDto>();
        sessions.MapPost("/{sessionId:guid}/confirm", ConfirmAsync).WithName("ConfirmTableSession").Produces<TableSessionDto>();
        sessions.MapScans();
    }

    private static async Task<IResult> CreateAsync(Guid groupId, CreateTableSessionDto body, HttpContext http, LedgerDbContext db,
        TableSessionService svc, AuditWriter audit, TimeProvider clock, CancellationToken ct)
    {
        var title = body.Title?.Trim() ?? "";
        if (body.Id == Guid.Empty) return ApiError.Validation("id must be a client-generated UUID.");
        if (title.Length is < 1 or > 80) return ApiError.Validation("title must be 1–80 characters.");
        if (!Currencies.IsSupported(body.Currency ?? "")) return ApiError.BadRequest(ErrorCodes.CurrencyUnsupported);
        if (!await db.Members.AnyAsync(m => m.Id == body.PayerMemberId && m.GroupId == groupId, ct))
            return ApiError.BadRequest(ErrorCodes.MemberNotInGroup, "The payer must be in this group.");
        if (await db.ReceiptSessions.AnyAsync(s => s.Id == body.Id, ct)) return ApiError.Conflict(ErrorCodes.AlreadyExists);

        var caller = GroupMemberFilter.CallerMember(http);
        var now = clock.NowMicros();
        var session = new ReceiptSession
        {
            Id = body.Id, GroupId = groupId, HostUserId = caller.User.Id, PayerMemberId = body.PayerMemberId, Currency = body.Currency!,
            Title = title, Status = SessionStatus.Open, Version = 1, CreatedAt = now, UpdatedAt = now,
        };
        db.ReceiptSessions.Add(session);
        audit.Record(caller.User.Id, groupId, EntityType, session.Id, AuditActions.Created, null, new { session.Title, session.Currency });
        await db.SaveChangesAsync(ct);
        return Results.Created($"/groups/{groupId}/table-sessions/{session.Id}", await svc.ToDtoAsync(session, Viewer(http), ct));
    }

    /// <summary>Bills still being split (open or locked), newest first, so anyone in the group can get back to one.</summary>
    private static async Task<IResult> ListActiveAsync(Guid groupId, HttpContext http, LedgerDbContext db, CancellationToken ct)
    {
        var me = GroupMemberFilter.CallerMember(http).User.Id;
        var active = await db.ReceiptSessions.AsNoTracking()
            .Where(s => s.GroupId == groupId && (s.Status == SessionStatus.Open || s.Status == SessionStatus.Locked))
            .OrderByDescending(s => s.CreatedAt).ThenBy(s => s.Id)
            .Select(s => new ActiveTableDto(s.Id, s.Title, s.Status, s.HostUserId == me))
            .ToListAsync(ct);
        return Results.Ok(active);
    }

    private static async Task<IResult> GetAsync(Guid groupId, Guid sessionId, HttpContext http, TableSessionService svc, CancellationToken ct) =>
        await svc.LoadAsync(groupId, sessionId, ct) is { } s ? Results.Ok(await svc.ToDtoAsync(s, Viewer(http), ct)) : ApiError.NotFound();

    private static async Task<IResult> ReplaceItemsAsync(Guid groupId, Guid sessionId, ReplaceItemsDto body, HttpContext http,
        LedgerDbContext db, TableSessionService svc, AuditWriter audit, TimeProvider clock, CancellationToken ct)
    {
        var items = body.Items ?? [];
        if (items.Count > MaxItems) return ApiError.Validation($"At most {MaxItems} items.");
        if (items.Select(i => i.Id).Distinct().Count() != items.Count || items.Any(i => i.Id == Guid.Empty))
            return ApiError.Validation("Each item needs its own id.");
        if (items.Any(i => (i.Description?.Trim().Length ?? 0) is < 1 or > 80 || i.Quantity is < 1 or > 99
                           || i.LineTotalMinor is < 0 or > SplitCalculator.MaxTotalMinor))
            return ApiError.Validation("Each item needs a description (1–80), quantity 1–99 and a non-negative total.");

        return await EditOpenSessionAsync(groupId, sessionId, http, db, svc, audit, clock, ct, session =>
        {
            var wanted = items.Select(i => i.Id).ToHashSet();
            session.Items.RemoveAll(i => !wanted.Contains(i.Id));
            for (var position = 0; position < items.Count; position++)
            {
                var input = items[position];
                var item = session.Items.SingleOrDefault(i => i.Id == input.Id);
                if (item is null)
                {
                    item = new ReceiptItem { Id = input.Id, SessionId = session.Id, Description = "" };
                    session.Items.Add(item);
                }
                item.Description = input.Description.Trim();
                item.Quantity = input.Quantity;
                item.LineTotalMinor = input.LineTotalMinor;
                item.Position = position;
            }
            return new { items = items.Count, itemsTotalMinor = items.Sum(i => i.LineTotalMinor) };
        });
    }

    private static async Task<IResult> ReplaceChargesAsync(Guid groupId, Guid sessionId, ReplaceChargesDto body, HttpContext http,
        LedgerDbContext db, TableSessionService svc, AuditWriter audit, TimeProvider clock, CancellationToken ct)
    {
        var charges = body.Charges ?? [];
        if (charges.Count > MaxCharges || charges.Select(c => c.Id).Distinct().Count() != charges.Count || charges.Any(c => c.Id == Guid.Empty)
            || charges.Any(c => !ChargeKinds.All.Contains(c.Kind ?? "") || c.AmountMinor is < 0 or > SplitCalculator.MaxTotalMinor))
            return ApiError.Validation("Charges are tip, service, delivery or other, each a non-negative amount (VAT is already in item prices).");

        return await EditOpenSessionAsync(groupId, sessionId, http, db, svc, audit, clock, ct, session =>
        {
            // Matched by id like items, so re-sending the same list (same ids) is an update, not a clash.
            var wanted = charges.Select(c => c.Id).ToHashSet();
            session.Charges.RemoveAll(c => !wanted.Contains(c.Id));
            foreach (var input in charges)
            {
                var charge = session.Charges.SingleOrDefault(c => c.Id == input.Id);
                if (charge is null)
                {
                    charge = new ReceiptCharge { Id = input.Id, SessionId = session.Id, Kind = input.Kind };
                    session.Charges.Add(charge);
                }
                charge.Kind = input.Kind;
                charge.AmountMinor = input.AmountMinor;
            }
            return new { charges = charges.Select(c => new { c.Kind, c.AmountMinor }) };
        });
    }

    /// <summary>Host-only edit of an open session: applies the change, bumps the version, audits and notifies.</summary>
    private static async Task<IResult> EditOpenSessionAsync(Guid groupId, Guid sessionId, HttpContext http, LedgerDbContext db,
        TableSessionService svc, AuditWriter audit, TimeProvider clock, CancellationToken ct, Func<ReceiptSession, object> apply)
    {
        var caller = GroupMemberFilter.CallerMember(http);
        var host = await HostOfAsync(db, groupId, sessionId, ct);
        if (host is null) return ApiError.NotFound();
        if (host != caller.User.Id) return HostOnly();

        // Lock the session row while it is still open (like claims), so a concurrent lock/confirm can't
        // interleave and the version only ever moves forward.
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        if (!await BumpAsync(db, sessionId, clock, ct, SessionStatus.Open))
            return WrongState(await CurrentStatusAsync(db, sessionId, ct));

        var session = (await svc.LoadAsync(groupId, sessionId, ct))!;
        var after = apply(session);
        audit.Record(caller.User.Id, groupId, EntityType, session.Id, AuditActions.Updated, null, after);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            // Item and charge ids are client-generated; one that already belongs to another bill is refused.
            return ApiError.Conflict(ErrorCodes.AlreadyExists, "One of these ids is already used on another bill.");
        }
        await tx.CommitAsync(ct);
        await svc.NotifyAsync(session.Id, ct);
        return Results.Ok(await svc.ToDtoAsync(session, Viewer(http), ct));
    }

    private static async Task<IResult> ClaimAsync(Guid groupId, Guid sessionId, Guid itemId, bool claimed, HttpContext http,
        TableSessionService svc, CancellationToken ct)
    {
        var caller = GroupMemberFilter.CallerMember(http);
        if (!await svc.ExistsInGroupAsync(groupId, sessionId, ct)) return ApiError.NotFound();
        return await svc.SetClaimAsync(sessionId, itemId, ClaimantKinds.Member, caller.Member.Id, claimed, ct) switch
        {
            ChangeOutcome.Ok => Results.NoContent(),
            ChangeOutcome.Locked => SessionLocked(),
            ChangeOutcome.Closed => SessionClosed(),
            _ => ApiError.NotFound(),
        };
    }

    /// <summary>Moves the session from one state to another; repeating a move that already happened is fine.</summary>
    private static async Task<IResult> TransitionAsync(Guid groupId, Guid sessionId, string from, string to, HttpContext http,
        LedgerDbContext db, TableSessionService svc, AuditWriter audit, TimeProvider clock, CancellationToken ct)
    {
        var caller = GroupMemberFilter.CallerMember(http);
        var host = await HostOfAsync(db, groupId, sessionId, ct);
        if (host is null) return ApiError.NotFound();
        if (host != caller.User.Id) return HostOnly();

        // The status change and its audit entry commit together.
        await using (var tx = await db.Database.BeginTransactionAsync(ct))
        {
            var now = clock.NowMicros();
            var changed = await db.ReceiptSessions.Where(s => s.Id == sessionId && s.Status == from)
                .ExecuteUpdateAsync(u => u.SetProperty(s => s.Status, to).SetProperty(s => s.Version, s => s.Version + 1).SetProperty(s => s.UpdatedAt, now), ct);
            if (changed == 0)
            {
                var current = await CurrentStatusAsync(db, sessionId, ct);
                if (current != to) return WrongState(current);
            }
            else
            {
                audit.Record(caller.User.Id, groupId, EntityType, sessionId, AuditActions.Updated, new { status = from }, new { status = to });
                await db.SaveChangesAsync(ct);
                await tx.CommitAsync(ct);
                await svc.NotifyAsync(sessionId, ct);
            }
        }

        return Results.Ok(await svc.ToDtoAsync((await svc.LoadAsync(groupId, sessionId, ct))!, Viewer(http), ct));
    }

    private static async Task<IResult> CancelAsync(Guid groupId, Guid sessionId, HttpContext http, LedgerDbContext db,
        TableSessionService svc, AuditWriter audit, TimeProvider clock, CancellationToken ct)
    {
        var open = await TransitionAsync(groupId, sessionId, SessionStatus.Open, SessionStatus.Cancelled, http, db, svc, audit, clock, ct);
        if (open is not IStatusCodeHttpResult { StatusCode: StatusCodes.Status409Conflict }) return open;
        return await TransitionAsync(groupId, sessionId, SessionStatus.Locked, SessionStatus.Cancelled, http, db, svc, audit, clock, ct);
    }

    private static async Task<IResult> MapGuestAsync(Guid groupId, Guid sessionId, Guid guestId, MapGuestDto body, HttpContext http,
        LedgerDbContext db, TableSessionService svc, AuditWriter audit, TimeProvider clock, CancellationToken ct)
    {
        var caller = GroupMemberFilter.CallerMember(http);
        var host = await HostOfAsync(db, groupId, sessionId, ct);
        if (host is null) return ApiError.NotFound();
        if (host != caller.User.Id) return HostOnly();
        if (body.MemberId is { } memberId && !await db.Members.AnyAsync(m => m.Id == memberId && m.GroupId == groupId, ct))
            return ApiError.BadRequest(ErrorCodes.MemberNotInGroup);

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        if (!await BumpAsync(db, sessionId, clock, ct, SessionStatus.Open, SessionStatus.Locked)) return SessionClosed();
        var session = (await svc.LoadAsync(groupId, sessionId, ct))!;
        var guest = session.Guests.SingleOrDefault(g => g.Id == guestId);
        if (guest is null) return ApiError.NotFound();

        guest.MappedMemberId = body.MemberId;
        audit.Record(caller.User.Id, groupId, EntityType, session.Id, AuditActions.Updated, null, new { guest = guest.Id, mappedTo = body.MemberId });
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        await svc.NotifyAsync(session.Id, ct);
        return Results.Ok(await svc.ToDtoAsync(session, Viewer(http), ct));
    }

    /// <summary>
    /// Turns the session into one itemized expense. Idempotent: confirming again returns the same expense.
    /// The status update takes the session row lock first, so no claim can land between reading and confirming;
    /// any validation failure after it leaves the transaction uncommitted, so the status rolls back.
    /// </summary>
    private static async Task<IResult> ConfirmAsync(Guid groupId, Guid sessionId, HttpContext http, LedgerDbContext db,
        TableSessionService svc, AuditWriter audit, Outbox outbox, ExpenseRates rates, Notifier notifier, TimeProvider clock,
        CancellationToken ct)
    {
        var caller = GroupMemberFilter.CallerMember(http);
        var existing = await db.ReceiptSessions.AsNoTracking().SingleOrDefaultAsync(s => s.Id == sessionId && s.GroupId == groupId, ct);
        if (existing is null) return ApiError.NotFound();
        if (existing.HostUserId != caller.User.Id) return HostOnly();
        if (existing.Status == SessionStatus.Confirmed) return Results.Ok(await svc.ToDtoAsync((await svc.LoadAsync(groupId, sessionId, ct))!, Viewer(http), ct));
        if (existing.Status == SessionStatus.Cancelled) return SessionClosed();

        // Asked before the transaction, so a slow pulse never holds it open. Pulse down → saved without a rate.
        var groupCurrency = await ExpenseEndpoints.GroupCurrencyAsync(db, groupId, ct);
        var rate = await rates.DecideAsync(existing.Currency.Trim(), groupCurrency, BillDate(existing), null, null, ct);

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var now = clock.NowMicros();
        var claimed = await db.ReceiptSessions
            .Where(s => s.Id == sessionId && (s.Status == SessionStatus.Open || s.Status == SessionStatus.Locked))
            .ExecuteUpdateAsync(u => u.SetProperty(s => s.Status, SessionStatus.Confirmed).SetProperty(s => s.Version, s => s.Version + 1)
                .SetProperty(s => s.UpdatedAt, now), ct);
        if (claimed == 0)
        {
            // Someone else confirmed or cancelled in the meantime.
            await tx.RollbackAsync(ct);
            var after = (await svc.LoadAsync(groupId, sessionId, ct))!;
            return after.Status == SessionStatus.Confirmed ? Results.Ok(await svc.ToDtoAsync(after, Viewer(http), ct)) : SessionClosed();
        }

        var session = (await svc.LoadAsync(groupId, sessionId, ct))!;
        var guests = session.Guests.ToDictionary(g => g.Id);
        if (session.Items.SelectMany(i => i.Claims).Any(c => c.ClaimantKind == ClaimantKinds.Guest && guests[c.ClaimantId].MappedMemberId is null))
            return ApiError.Conflict(ErrorCodes.GuestsUnmapped, "Match every guest who claimed something to a group member first.");

        Guid MemberOf(ItemClaim c) => c.ClaimantKind == ClaimantKinds.Member ? c.ClaimantId : guests[c.ClaimantId].MappedMemberId!.Value;
        var items = session.Items.Select(i => new ItemInput(i.Id, i.LineTotalMinor, i.Claims.Select(MemberOf).Distinct().ToList())).ToList();
        var participants = items.SelectMany(i => i.ClaimerIds).Distinct().ToList();
        if (participants.Count == 0) return ApiError.Validation("Nobody has claimed anything yet.");

        var charges = session.Charges.Sum(c => c.AmountMinor);
        if (ItemizedSplitCalculator.Calculate(items, charges, participants) is not SplitResult.Ok split)
            return ApiError.Validation("This bill can't be split as entered.");

        var total = items.Sum(i => i.LineTotalMinor) + charges;
        var expense = new Expense
        {
            Id = Guid.NewGuid(), GroupId = groupId, Description = session.Title, Category = "food", Currency = session.Currency.Trim(),
            AmountMinor = total, OccurredOn = BillDate(session), SplitMethod = SplitMethod.Itemized,
            Version = 1, CreatedByUserId = caller.User.Id, CreatedAt = now, UpdatedAt = now,
            Payers = [new ExpensePayer { MemberId = session.PayerMemberId, AmountMinor = total }],
            Shares = split.Shares.Select(x => new ExpenseShare { MemberId = x.MemberId, AmountMinor = x.Minor }).ToList(),
        };
        if (ExpenseEndpoints.ApplyRate(expense, rate, groupCurrency) is { } rateError) return rateError;
        db.Expenses.Add(expense);
        session.ExpenseId = expense.Id;
        audit.Record(caller.User.Id, groupId, ExpenseEndpoints.EntityType, expense.Id, AuditActions.Created, null, expense.ToDto());
        audit.Record(caller.User.Id, groupId, EntityType, session.Id, AuditActions.Updated, null, new { status = SessionStatus.Confirmed, expenseId = expense.Id });
        outbox.ExpenseChanged(groupId, expense.Id, ExpenseChanged.Types.Change.Created);
        await notifier.ExpenseAddedAsync(expense, caller.User.Id, ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        LedgerTelemetry.CountExpenseCreated(expense.SplitMethod);

        await svc.NotifyAsync(session.Id, ct);
        return Results.Ok(await svc.ToDtoAsync(session, Viewer(http), ct));
    }

    internal static TableViewerDto Viewer(HttpContext http) => TableSessionService.ViewerFor(GroupMemberFilter.CallerMember(http).Member);

    internal static Task<Guid?> HostOfAsync(LedgerDbContext db, Guid groupId, Guid sessionId, CancellationToken ct) =>
        db.ReceiptSessions.Where(s => s.Id == sessionId && s.GroupId == groupId).Select(s => (Guid?)s.HostUserId).SingleOrDefaultAsync(ct);

    internal static Task<string> CurrentStatusAsync(LedgerDbContext db, Guid sessionId, CancellationToken ct) =>
        db.ReceiptSessions.Where(s => s.Id == sessionId).Select(s => s.Status).SingleAsync(ct);

    /// <summary>Atomically bumps the version if the session is in one of the given states; takes the row lock.</summary>
    internal static async Task<bool> BumpAsync(LedgerDbContext db, Guid sessionId, TimeProvider clock, CancellationToken ct, params string[] states)
    {
        var now = clock.NowMicros();
        return await db.ReceiptSessions.Where(s => s.Id == sessionId && states.Contains(s.Status))
            .ExecuteUpdateAsync(u => u.SetProperty(s => s.Version, s => s.Version + 1).SetProperty(s => s.UpdatedAt, now), ct) == 1;
    }

    /// <summary>The 409 for an action the session's current state doesn't allow.</summary>
    internal static IResult WrongState(string status) =>
        status is SessionStatus.Confirmed or SessionStatus.Cancelled ? SessionClosed() : SessionLocked();

    internal static IResult HostOnly() => ApiError.Problem(StatusCodes.Status403Forbidden, ErrorCodes.HostOnly, "Only the person running this table can do that.");
    public static IResult SessionLocked() => ApiError.Conflict(ErrorCodes.SessionLocked, "The host has locked this bill.");
    public static IResult SessionClosed() => ApiError.Conflict(ErrorCodes.SessionClosed, "This bill is already settled or cancelled.");

    /// <summary>A table bill is dated the day the table was opened (UTC).</summary>
    private static DateOnly BillDate(ReceiptSession s) => DateOnly.FromDateTime(s.CreatedAt.UtcDateTime);
}
