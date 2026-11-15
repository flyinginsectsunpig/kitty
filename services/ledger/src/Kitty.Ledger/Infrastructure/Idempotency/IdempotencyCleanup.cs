using Kitty.Ledger.Data;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Infrastructure.Idempotency;

/// <summary>Hourly: deletes idempotency records older than 24 hours.</summary>
public sealed class IdempotencyCleanup(IServiceScopeFactory scopes, TimeProvider clock, ILogger<IdempotencyCleanup> log)
    : BackgroundService
{
    public static readonly TimeSpan Retention = TimeSpan.FromHours(24);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromHours(1), clock);
        do
        {
            try
            {
                using var scope = scopes.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<LedgerDbContext>();
                var cutoff = clock.GetUtcNow() - Retention;
                var deleted = await db.IdempotencyRecords.Where(r => r.CreatedAt < cutoff).ExecuteDeleteAsync(stoppingToken);
                if (deleted > 0) log.LogInformation("Deleted {Count} expired idempotency records", deleted);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogWarning(ex, "Idempotency cleanup failed; will retry next hour");
            }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
