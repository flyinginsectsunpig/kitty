using System.Globalization;
using System.Text.RegularExpressions;
using Grpc.Core;
using Kitty.Contracts.Ledger.V1;
using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Domain;
using Kitty.Ledger.Features.Balances;
using Microsoft.EntityFrameworkCore;
using Kind = Kitty.Contracts.Notify.V1.NotificationRequested.Types.Kind;

namespace Kitty.Ledger.Features.Notifications;

/// <summary>pulse's notification calls into the ledger (its service token only, internal port; see RecurringGrpcService).</summary>
public sealed partial class NotifyGrpcService(LedgerDbContext db, Notifier notifier, NotifySettingsPublisher publisher, TimeProvider clock)
    : NotifyService.NotifyServiceBase
{
    [GeneratedRegex(@"^(\d{4})-W(\d{2})$")]
    private static partial Regex IsoWeek();

    /// <summary>One summary per person who owes anything, per currency across their groups. Once per person per week.</summary>
    public override async Task<QueueWeeklySummariesResponse> QueueWeeklySummaries(QueueWeeklySummariesRequest request, ServerCallContext context)
    {
        var ct = context.CancellationToken;
        var m = IsoWeek().Match(request.Week ?? "");
        if (!m.Success || int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture) is < 1 or > 53)
            throw new RpcException(new Status(StatusCode.InvalidArgument, "week must look like 2026-W48."));

        var memberships = await db.Members.Where(x => x.UserId != null).Select(x => new { x.Id, x.GroupId, UserId = x.UserId!.Value })
            .ToListAsync(ct);
        var owed = new Dictionary<Guid, (Dictionary<string, long> ByCurrency, HashSet<Guid> Groups)>();
        foreach (var group in memberships.GroupBy(x => x.GroupId))
        {
            var nets = await BalanceQueries.NetByCurrencyAsync(db, group.Key, ct);
            foreach (var member in group)
            foreach (var (currency, net) in nets.Select(n => (n.Key, n.Value.GetValueOrDefault(member.Id))).Where(n => n.Item2 < 0))
            {
                if (!owed.TryGetValue(member.UserId, out var o)) owed[member.UserId] = o = (new(StringComparer.Ordinal), []);
                o.ByCurrency[currency] = o.ByCurrency.GetValueOrDefault(currency) - net;
                o.Groups.Add(group.Key);
            }
        }

        var already = await db.WeeklySummaries.Where(w => w.Week == request.Week).Select(w => w.UserId).ToListAsync(ct);
        var queued = 0;
        foreach (var (userId, (byCurrency, groups)) in owed.Where(o => !already.Contains(o.Key)))
        {
            var amounts = string.Join(" and ", byCurrency.OrderBy(c => c.Key, StringComparer.Ordinal).Select(c => MoneyText.Format(c.Value, c.Key)));
            var body = $"You owe {amounts} across {groups.Count} {(groups.Count == 1 ? "group" : "groups")}";
            db.WeeklySummaries.Add(new WeeklySummary { UserId = userId, Week = request.Week!, QueuedAt = clock.GetUtcNow() });
            notifier.Queue(userId, Kind.WeeklySummary, "Kitty", body, groupId: null);
            queued++;
        }
        await db.SaveChangesAsync(ct);
        return new QueueWeeklySummariesResponse { Queued = queued };
    }

    /// <summary>A token Firebase says is dead: forget it and republish its owner's delivery state. Idempotent.</summary>
    public override async Task<ForgetDeviceResponse> ForgetDevice(ForgetDeviceRequest request, ServerCallContext context)
    {
        var ct = context.CancellationToken;
        var device = await db.PushDevices.SingleOrDefaultAsync(d => d.Token == request.Token, ct);
        if (device is null) return new ForgetDeviceResponse();
        db.PushDevices.Remove(device);
        await publisher.QueueAsync(await db.Users.SingleAsync(u => u.Id == device.UserId, ct), ct);
        await db.SaveChangesAsync(ct);
        return new ForgetDeviceResponse();
    }
}
