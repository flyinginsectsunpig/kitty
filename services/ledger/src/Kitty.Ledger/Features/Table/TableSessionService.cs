using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Domain.Splits;
using Kitty.Ledger.Infrastructure;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Table;

public enum ChangeOutcome { Ok, NotFound, Locked, Closed }

/// <summary>Session reads and the claim path shared by members (Task 4) and guests (Task 5).</summary>
public sealed class TableSessionService(LedgerDbContext db, TimeProvider clock, ITableNotifier notifier)
{
    public Task<ReceiptSession?> LoadAsync(Guid groupId, Guid sessionId, CancellationToken ct) =>
        db.ReceiptSessions
            .Include(s => s.Items.OrderBy(i => i.Position)).ThenInclude(i => i.Claims)
            .Include(s => s.Charges)
            .Include(s => s.Guests)
            .AsSplitQuery()
            .SingleOrDefaultAsync(s => s.Id == sessionId && s.GroupId == groupId, ct);

    public async Task<TableSessionDto> ToDtoAsync(ReceiptSession s, CancellationToken ct)
    {
        var memberNames = await db.Members.Where(m => m.GroupId == s.GroupId).ToDictionaryAsync(m => m.Id, m => m.DisplayName, ct);
        var guests = s.Guests.ToDictionary(g => g.Id);

        ClaimantDto Effective(ItemClaim c)
        {
            if (c.ClaimantKind == ClaimantKinds.Member) return new(ClaimantKinds.Member, c.ClaimantId, memberNames.GetValueOrDefault(c.ClaimantId, "Someone"));
            var guest = guests[c.ClaimantId];
            return guest.MappedMemberId is { } memberId
                ? new(ClaimantKinds.Member, memberId, memberNames.GetValueOrDefault(memberId, guest.DisplayName))
                : new(ClaimantKinds.Guest, guest.Id, guest.DisplayName);
        }

        var items = s.Items.Select(i => new TableItemDto(i.Id, i.Description, i.Quantity, i.LineTotalMinor,
            i.Claims.Select(Effective).DistinctBy(c => c.Id).ToList())).ToList();

        var people = items.SelectMany(i => i.Claimants).DistinctBy(c => c.Id).ToDictionary(c => c.Id);
        var preview = ItemizedSplitCalculator.Calculate(
                items.Select(i => new ItemInput(i.Id, i.LineTotalMinor, i.Claimants.Select(c => c.Id).ToList())).ToList(),
                s.Charges.Sum(c => c.AmountMinor), people.Keys.ToList()) switch
        {
            SplitResult.Ok ok => ok.Shares.Select(x => new PreviewShareDto(people[x.MemberId].Kind, x.MemberId, people[x.MemberId].DisplayName, x.Minor)).ToList(),
            _ => [],
        };

        return new TableSessionDto(s.Id, s.Title, s.Currency.Trim(), s.Status, s.Version, s.PayerMemberId, s.ExpenseId, items,
            s.Charges.Select(c => new TableChargeDto(c.Id, c.Kind, c.AmountMinor)).ToList(),
            s.Guests.Select(g => new TableGuestDto(g.Id, g.DisplayName, g.MappedMemberId)).ToList(),
            preview);
    }

    /// <summary>
    /// Adds or removes one claim. The session row's version bump runs first, only while the session is open,
    /// and takes Postgres's row lock: so concurrent claims all succeed, and no claim lands after a lock/confirm.
    /// </summary>
    public async Task<ChangeOutcome> SetClaimAsync(Guid sessionId, Guid itemId, string claimantKind, Guid claimantId, bool claimed, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var now = clock.NowMicros();
        var bumped = await db.ReceiptSessions
            .Where(s => s.Id == sessionId && s.Status == SessionStatus.Open)
            .ExecuteUpdateAsync(u => u.SetProperty(s => s.Version, s => s.Version + 1).SetProperty(s => s.UpdatedAt, now), ct);
        if (bumped == 0) return await StatusOutcomeAsync(sessionId, ct);
        if (!await db.ReceiptItems.AnyAsync(i => i.Id == itemId && i.SessionId == sessionId, ct)) return ChangeOutcome.NotFound;

        if (claimed)
            await db.Database.ExecuteSqlInterpolatedAsync(
                $"""INSERT INTO "ItemClaims" ("ItemId", "ClaimantKind", "ClaimantId") VALUES ({itemId}, {claimantKind}, {claimantId}) ON CONFLICT DO NOTHING""", ct);
        else
            await db.ItemClaims.Where(c => c.ItemId == itemId && c.ClaimantKind == claimantKind && c.ClaimantId == claimantId).ExecuteDeleteAsync(ct);

        await tx.CommitAsync(ct);
        await NotifyAsync(sessionId, ct);
        return ChangeOutcome.Ok;
    }

    public async Task<ChangeOutcome> StatusOutcomeAsync(Guid sessionId, CancellationToken ct) =>
        await db.ReceiptSessions.Where(s => s.Id == sessionId).Select(s => s.Status).SingleOrDefaultAsync(ct) switch
        {
            null => ChangeOutcome.NotFound,
            SessionStatus.Open => ChangeOutcome.Ok,
            SessionStatus.Locked => ChangeOutcome.Locked,
            _ => ChangeOutcome.Closed,
        };

    public async Task NotifyAsync(Guid sessionId, CancellationToken ct)
    {
        var version = await db.ReceiptSessions.Where(s => s.Id == sessionId).Select(s => s.Version).SingleAsync(ct);
        await notifier.NotifyAsync(sessionId, version, ct);
    }
}
