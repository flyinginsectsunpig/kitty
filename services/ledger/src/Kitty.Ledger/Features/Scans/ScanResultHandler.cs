using Kitty.Contracts.Events.V1;
using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Domain.Splits;
using Kitty.Ledger.Features.Table;
using Kitty.Ledger.Infrastructure;
using Kitty.Ledger.Infrastructure.Messaging;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Scans;

/// <summary>
/// Records what the ai service read from a receipt. A result fills the bill only if it is open and still empty;
/// otherwise it waits as a suggestion, so a scan never overwrites what the host typed.
/// </summary>
public sealed class ScanResultHandler(LedgerDbContext db, TableSessionService svc, TimeProvider clock)
{
    public async Task ApplyAsync(ReceiptResult result, CancellationToken ct)
    {
        if (!Guid.TryParse(result.ScanId, out var scanId)) return; // not ours to handle

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var now = clock.NowMicros();
        var fresh = await db.Database.ExecuteSqlInterpolatedAsync(
            $"""INSERT INTO "InboxMessages" ("EventId", "Topic", "ProcessedAt") VALUES ({result.EventId}, {Topics.ReceiptParsed}, {now}) ON CONFLICT DO NOTHING""", ct);
        if (fresh == 0) return; // seen before

        var sessionId = await db.ReceiptScans.Where(s => s.Id == scanId).Select(s => (Guid?)s.SessionId).SingleOrDefaultAsync(ct);
        if (sessionId is null)
        {
            await tx.CommitAsync(ct);
            return;
        }
        // Take the bill's row lock before reading anything, as every edit of the bill does: a save, a new scan or
        // the timeout running at the same moment then happens wholly before or after this.
        await db.Database.ExecuteSqlInterpolatedAsync($"""SELECT 1 FROM "ReceiptSessions" WHERE "Id" = {sessionId} FOR UPDATE""", ct);
        var scan = await db.ReceiptScans.SingleAsync(s => s.Id == scanId, ct);
        if (scan.Status != ScanStatus.Parsing)
        {
            await tx.CommitAsync(ct); // a late result for a replaced, timed-out or finished scan
            return;
        }

        scan.FinishedAt = now;
        if (result.OutcomeCase == ReceiptResult.OutcomeOneofCase.Parsed)
        {
            var suggestion = ToSuggestion(result.Parsed);
            scan.Status = ScanStatus.Parsed;
            scan.SuggestionJson = ScanViews.Serialize(suggestion);
            var session = await db.ReceiptSessions.Include(s => s.Items).Include(s => s.Charges).SingleAsync(s => s.Id == scan.SessionId, ct);
            // Only a bill with nothing typed on it (no items, no tip) is filled; otherwise the host chooses.
            if (session.Status == SessionStatus.Open && session.Items.Count == 0 && session.Charges.Count == 0)
            {
                Replace(session, suggestion);
                scan.AppliedAt = now;
            }
        }
        else
        {
            scan.Status = ScanStatus.Failed;
            scan.FailureReason = ReasonCode(result.Failed?.Reason ?? ScanFailure.Types.Reason.Unspecified);
        }

        await db.SaveChangesAsync(ct);
        // A closed bill keeps its UpdatedAt (when it closed): the 90-day photo deletion counts from it.
        var live = await db.ReceiptSessions
            .Where(s => s.Id == scan.SessionId && (s.Status == SessionStatus.Open || s.Status == SessionStatus.Locked))
            .ExecuteUpdateAsync(u => u.SetProperty(s => s.Version, s => s.Version + 1).SetProperty(s => s.UpdatedAt, now), ct);
        await tx.CommitAsync(ct);
        if (live == 1) await svc.NotifyAsync(scan.SessionId, ct);
    }

    /// <summary>Puts the suggestion on the bill in place of its items and charges (claims on removed items go with them).</summary>
    public static void Replace(ReceiptSession session, ScanSuggestion suggestion)
    {
        session.Items.Clear();
        session.Charges.Clear();
        for (var position = 0; position < suggestion.Items.Count; position++)
        {
            var i = suggestion.Items[position];
            session.Items.Add(new ReceiptItem
            {
                Id = i.Id, SessionId = session.Id, Description = i.Description, Quantity = i.Quantity,
                LineTotalMinor = i.LineTotalMinor, Position = position,
            });
        }
        foreach (var c in suggestion.Charges)
            session.Charges.Add(new ReceiptCharge { Id = c.Id, SessionId = session.Id, Kind = c.Kind, AmountMinor = c.AmountMinor });
    }

    /// <summary>
    /// Fits what was read into the table's rules (the same ones typed items follow), with fresh ids so the
    /// suggestion can be applied as-is. Nothing here trusts the model: lengths, counts and amounts are bounded.
    /// </summary>
    public static ScanSuggestion ToSuggestion(ParsedReceipt parsed)
    {
        var items = parsed.Items
            .Where(i => i.LineTotalMinor is >= 0 and <= SplitCalculator.MaxTotalMinor && !string.IsNullOrWhiteSpace(i.Description))
            .Take(TableEndpoints.MaxItems)
            .Select(i => new ItemWriteDto(Guid.NewGuid(), Truncate(i.Description.Trim(), 80), Math.Clamp(i.Quantity, 1, 99), i.LineTotalMinor))
            .ToList();
        var charges = parsed.Charges
            .Where(c => c.AmountMinor is > 0 and <= SplitCalculator.MaxTotalMinor)
            .Take(TableEndpoints.MaxCharges)
            .Select(c => new ChargeWriteDto(Guid.NewGuid(), ChargeKinds.All.Contains(c.Kind) ? c.Kind : ChargeKinds.Other, c.AmountMinor))
            .ToList();
        return new ScanSuggestion(items, charges);
    }

    public static string ReasonCode(ScanFailure.Types.Reason reason) => reason switch
    {
        ScanFailure.Types.Reason.Unreadable => "unreadable",
        ScanFailure.Types.Reason.NoItems => "no_items",
        ScanFailure.Types.Reason.TotalsMismatch => "totals_mismatch",
        ScanFailure.Types.Reason.RateLimited => "rate_limited",
        ScanFailure.Types.Reason.ModelUnavailable => "model_unavailable",
        _ => "unreadable",
    };

    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
