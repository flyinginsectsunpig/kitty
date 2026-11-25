using Kitty.Ledger.Data;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Notifications;

/// <summary>
/// Publishes the default notification settings of people who existed before notifications did (new people are
/// published when first seen), so pulse can tell them about expenses. Runs at start; a no-op once everyone has a row.
/// </summary>
public sealed class NotifySettingsBackfill(IServiceScopeFactory scopes, ILogger<NotifySettingsBackfill> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = scopes.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<LedgerDbContext>();
                var publisher = scope.ServiceProvider.GetRequiredService<NotifySettingsPublisher>();
                var missing = await db.Users.Where(u => !db.NotificationSettings.Any(s => s.UserId == u.Id)).ToListAsync(stoppingToken);
                foreach (var user in missing) await publisher.QueueAsync(user, stoppingToken);
                if (missing.Count > 0) await db.SaveChangesAsync(stoppingToken);
                if (missing.Count > 0) log.LogInformation("Published default notification settings for {Count} people", missing.Count);
                return;
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                // Usually the database isn't migrated or reachable yet.
                log.LogWarning(e, "Notification settings backfill failed; retrying");
                await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
            }
        }
    }
}
