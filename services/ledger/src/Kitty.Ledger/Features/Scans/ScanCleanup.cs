using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Features.Table;
using Kitty.Ledger.Infrastructure;
using Kitty.Ledger.Infrastructure.Blob;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Scans;

public sealed record CleanupReport(int TimedOut, int StaleUploadsDeleted, int ExpiredBlobsDeleted);

/// <summary>
/// Hourly housekeeping for receipt scans:
/// a scan still being read after 10 minutes fails as "timed_out" (the host types the items instead);
/// an upload URL nobody used within a day is forgotten, with anything uploaded to it;
/// and a receipt photo is deleted 90 days after its bill was confirmed or cancelled (privacy).
/// </summary>
public sealed class ScanCleanup(IServiceScopeFactory scopes, ReceiptBlobs blobs, TimeProvider clock, ILogger<ScanCleanup> log)
    : BackgroundService
{
    public static readonly TimeSpan ParsingTimeout = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan UploadAbandonedAfter = TimeSpan.FromHours(24);
    public static readonly TimeSpan PhotoRetention = TimeSpan.FromDays(90);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Every few minutes, so a stuck scan fails close to its 10-minute mark.
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(2), clock);
        do
        {
            try
            {
                var report = await RunOnceAsync(stoppingToken);
                if (report != new CleanupReport(0, 0, 0)) log.LogInformation("Scan cleanup: {Report}", report);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogWarning(ex, "Scan cleanup failed; will retry");
            }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    public async Task<CleanupReport> RunOnceAsync(CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<LedgerDbContext>();
        var svc = scope.ServiceProvider.GetRequiredService<TableSessionService>();
        var now = clock.NowMicros();

        var stuck = await db.ReceiptScans.Where(s => s.Status == ScanStatus.Parsing && s.UploadedAt < now - ParsingTimeout).ToListAsync(ct);
        foreach (var scan in stuck)
        {
            scan.Status = ScanStatus.Failed;
            scan.FailureReason = "timed_out";
            scan.FinishedAt = now;
        }
        await db.SaveChangesAsync(ct);
        foreach (var sessionId in stuck.Select(s => s.SessionId).Distinct())
        {
            // Only bills still on screen need to hear about it. A closed bill's UpdatedAt is when it closed,
            // which the 90-day photo deletion below counts from, so it must not move.
            var live = await db.ReceiptSessions
                .Where(s => s.Id == sessionId && (s.Status == SessionStatus.Open || s.Status == SessionStatus.Locked))
                .ExecuteUpdateAsync(u => u.SetProperty(s => s.Version, s => s.Version + 1).SetProperty(s => s.UpdatedAt, now), ct);
            if (live == 1) await svc.NotifyAsync(sessionId, ct);
        }

        var abandoned = await db.ReceiptScans.Where(s => s.Status == ScanStatus.AwaitingUpload && s.CreatedAt < now - UploadAbandonedAfter).ToListAsync(ct);
        foreach (var scan in abandoned) await blobs.DeleteAsync(scan.BlobName, ct);
        db.ReceiptScans.RemoveRange(abandoned);
        await db.SaveChangesAsync(ct);

        var closedBefore = now - PhotoRetention;
        var expired = await db.ReceiptScans
            .Where(s => s.BlobDeletedAt == null && s.Status != ScanStatus.AwaitingUpload)
            .Join(db.ReceiptSessions.Where(x => (x.Status == SessionStatus.Confirmed || x.Status == SessionStatus.Cancelled) && x.UpdatedAt < closedBefore),
                s => s.SessionId, x => x.Id, (s, _) => s)
            .ToListAsync(ct);
        foreach (var scan in expired)
        {
            await blobs.DeleteAsync(scan.BlobName, ct);
            scan.BlobDeletedAt = now;
        }
        await db.SaveChangesAsync(ct);

        return new CleanupReport(stuck.Count, abandoned.Count, expired.Count);
    }
}
