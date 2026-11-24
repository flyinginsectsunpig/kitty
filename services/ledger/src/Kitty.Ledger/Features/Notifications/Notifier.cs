using Google.Protobuf.WellKnownTypes;
using Kitty.Contracts.Notify.V1;
using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Domain;
using Kitty.Ledger.Infrastructure.Messaging;
using Microsoft.EntityFrameworkCore;
using Kind = Kitty.Contracts.Notify.V1.NotificationRequested.Types.Kind;

namespace Kitty.Ledger.Features.Notifications;

/// <summary>
/// Decides who is told about a change and what it says, and queues one request per person in the caller's unit of
/// work (so it's sent exactly when the change commits). Only the group's own members with an account who are involved,
/// never the person who made the change; the text uses only that group's data. pulse applies settings and delivers.
/// </summary>
public sealed class Notifier(LedgerDbContext db, Outbox outbox, TimeProvider clock)
{
    private sealed record Member(Guid Id, Guid UserId, string DisplayName);

    /// <param name="actorUserId">Who added it; null when nobody did (a recurring period added automatically).</param>
    public async Task ExpenseAddedAsync(Expense e, Guid? actorUserId, CancellationToken ct)
    {
        var (groupName, members) = await GroupAsync(e.GroupId, ct);
        var actor = actorUserId is { } a ? members.Values.FirstOrDefault(m => m.UserId == a)?.DisplayName ?? "Someone" : null;
        var involved = e.Payers.Select(p => p.MemberId).Concat(e.Shares.Select(s => s.MemberId)).Distinct();

        foreach (var memberId in involved)
        {
            if (!members.TryGetValue(memberId, out var m) || m.UserId == actorUserId) continue;
            var share = e.Shares.FirstOrDefault(s => s.MemberId == memberId);
            var what = share is not null
                ? $"your share {MoneyText.Format(share.AmountMinor, e.Currency.Trim())}"
                : $"you paid {MoneyText.Format(e.Payers.Single(p => p.MemberId == memberId).AmountMinor, e.Currency.Trim())}";
            var body = actor is null ? $"{e.Description} was added · {what}" : $"{actor} added {e.Description} · {what}";
            Queue(m.UserId, Kind.ExpenseAdded, groupName, body, e.GroupId);
        }
    }

    public async Task PaymentAsync(Settlement s, Guid actorUserId, CancellationToken ct)
    {
        var (groupName, members) = await GroupAsync(s.GroupId, ct);
        var actor = members.Values.FirstOrDefault(m => m.UserId == actorUserId)?.DisplayName ?? "Someone";
        var money = MoneyText.Format(s.AmountMinor, s.Currency.Trim());
        foreach (var (memberId, direction) in new[] { (s.ToMemberId, "to"), (s.FromMemberId, "by") })
        {
            if (!members.TryGetValue(memberId, out var m) || m.UserId == actorUserId) continue;
            Queue(m.UserId, Kind.Payment, groupName, $"{actor} marked {money} paid {direction} you", s.GroupId);
        }
    }

    /// <summary>Queues one request (also used by the weekly summary, with its own id and no group).</summary>
    public void Queue(Guid userId, Kind kind, string title, string body, Guid? groupId, Guid? notificationId = null) =>
        outbox.Add(Topics.NotificationsRequested, userId.ToString(), new NotificationRequested
        {
            NotificationId = (notificationId ?? Guid.NewGuid()).ToString(),
            UserId = userId.ToString(),
            Kind = kind,
            Title = title,
            Body = body,
            Link = groupId is { } g ? $"kitty://groups/{g}" : "kitty://groups",
            GroupId = groupId?.ToString() ?? "",
            OccurredAt = Timestamp.FromDateTimeOffset(clock.GetUtcNow()),
        });

    /// <summary>The group's name and its members who have an account, by member id.</summary>
    private async Task<(string Name, Dictionary<Guid, Member> Members)> GroupAsync(Guid groupId, CancellationToken ct)
    {
        var name = await db.Groups.Where(g => g.Id == groupId).Select(g => g.Name).SingleAsync(ct);
        var members = await db.Members.Where(m => m.GroupId == groupId && m.UserId != null)
            .Select(m => new Member(m.Id, m.UserId!.Value, m.DisplayName)).ToDictionaryAsync(m => m.Id, ct);
        return (name, members);
    }
}
