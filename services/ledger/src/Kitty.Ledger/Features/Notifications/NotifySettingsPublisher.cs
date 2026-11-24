using Kitty.Contracts.Notify.V1;
using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Infrastructure.Messaging;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Notifications;

/// <summary>
/// Queues a person's full delivery state (settings, verified email, push tokens) for pulse, on the compacted
/// ledger.notify-settings topic. The caller's SaveChanges commits it with the change.
/// </summary>
public sealed class NotifySettingsPublisher(LedgerDbContext db, Outbox outbox)
{
    /// <summary>The person's settings row, created with the defaults (and tracked) when missing.</summary>
    public async Task<NotificationSettings> SettingsAsync(Guid userId, CancellationToken ct)
    {
        var settings = db.NotificationSettings.Local.FirstOrDefault(s => s.UserId == userId)
            ?? await db.NotificationSettings.SingleOrDefaultAsync(s => s.UserId == userId, ct);
        if (settings is not null) return settings;
        settings = new NotificationSettings { UserId = userId };
        db.NotificationSettings.Add(settings);
        return settings;
    }

    public async Task QueueAsync(User user, CancellationToken ct)
    {
        var settings = await SettingsAsync(user.Id, ct);
        settings.Version++;
        // Pending adds and removals in this unit of work count too.
        var saved = await db.PushDevices.Where(d => d.UserId == user.Id).Select(d => d.Token).ToListAsync(ct);
        var tracked = db.ChangeTracker.Entries<PushDevice>().ToList();
        var tokens = saved
            .Except(tracked.Where(e => e.State == EntityState.Deleted || e.Entity.UserId != user.Id).Select(e => e.Entity.Token))
            .Union(tracked.Where(e => e.State != EntityState.Deleted && e.Entity.UserId == user.Id).Select(e => e.Entity.Token))
            .Order(StringComparer.Ordinal)
            .ToList();

        var message = new NotifySettingsChanged
        {
            UserId = user.Id.ToString(),
            Email = user.EmailVerified ? user.Email ?? "" : "",
            ExpensePush = settings.ExpensePush,
            ExpenseEmail = settings.ExpenseEmail,
            PaymentPush = settings.PaymentPush,
            PaymentEmail = settings.PaymentEmail,
            WeeklyPush = settings.WeeklyPush,
            WeeklyEmail = settings.WeeklyEmail,
            Version = settings.Version,
        };
        message.PushTokens.AddRange(tokens);
        outbox.Add(Topics.NotifySettings, user.Id.ToString(), message);
    }
}
