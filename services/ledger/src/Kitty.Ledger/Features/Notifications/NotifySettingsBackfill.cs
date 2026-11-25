using Kitty.Ledger.Data;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Notifications;

/// <summary>
/// Publishes the notification settings of people who existed before notifications did (new people are published when
/// first seen), and once more for everyone whose settings predate reminders, so pulse knows every person's current
/// state. Runs at start; a no-op once everyone is published.
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
                // No settings yet, or settings from before reminders existed (pulse hasn't been told those).
                var missing = await db.Users
                    .Where(u => !db.NotificationSettings.Any(s => s.UserId == u.Id && s.RemindersPublished)).ToListAsync(stoppingToken);
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
