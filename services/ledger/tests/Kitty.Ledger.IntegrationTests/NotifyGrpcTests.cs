using System.Net.Http.Headers;
using Grpc.Core;
using Grpc.Core.Interceptors;
using Grpc.Net.Client;
using Kitty.Contracts.Ledger.V1;
using Kitty.Contracts.Notify.V1;
using Kitty.Ledger.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Kitty.Ledger.IntegrationTests;

[Collection(ApiCollection.Name)]
public class NotifyGrpcTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private NotifyService.NotifyServiceClient Pulse(string token)
    {
        var channel = GrpcChannel.ForAddress("http://localhost:8082", new GrpcChannelOptions { HttpHandler = factory.Server.CreateHandler() });
        return new NotifyService.NotifyServiceClient(channel.Intercept(m => { m.Add("authorization", $"Bearer {token}"); return m; }));
    }

    private NotifyService.NotifyServiceClient AsPulse => Pulse(TestTokens.ForService("kitty-pulse"));

    private async Task<List<NotificationRequested>> SummariesForAsync(Guid userId)
    {
        using var scope = factory.Services.CreateScope();
        var rows = await scope.ServiceProvider.GetRequiredService<LedgerDbContext>().OutboxMessages
            .Where(m => m.Topic == "notifications.requested" && m.Key == userId.ToString()).Select(m => m.Payload).ToListAsync(Ct);
        return rows.Select(NotificationRequested.Parser.ParseFrom).Where(r => r.Kind == NotificationRequested.Types.Kind.WeeklySummary).ToList();
    }

    /// <summary>The friend owes the owner R 150,00 in one group and €20,00 in another.</summary>
    private async Task<(Guid OwnerU, Guid FriendU)> DebtsAsync()
    {
        var owner = factory.NewUser("Owner");
        var friend = factory.NewUser("Friend");
        foreach (var (currency, amount) in new[] { ("ZAR", 30000L), ("EUR", 4000L) })
        {
            var g = await owner.CreateGroupAsync();
            var joined = await friend.JoinAsync(owner, g.Id);
            var o = joined.Members.Single(m => m.DisplayName == "Owner").Id;
            var f = joined.Members.Single(m => m.DisplayName == "Friend").Id;
            if (currency != "ZAR") factory.Fx.Set(currency, "ZAR", new DateOnly(2026, 11, 15), 19m);
            await owner.AddEqualAsync(g.Id, amount, o, [o, f], currency: currency);
        }
        return ((await owner.MeAsync()).Id, (await friend.MeAsync()).Id);
    }

    [Fact]
    public async Task Weekly_summary_lists_what_each_person_owes_across_groups()
    {
        var (_, friend) = await DebtsAsync();

        var res = await AsPulse.QueueWeeklySummariesAsync(new QueueWeeklySummariesRequest { Week = "2026-W48" }, cancellationToken: Ct);

        Assert.True(res.Queued >= 1);
        var s = Assert.Single(await SummariesForAsync(friend));
        Assert.Equal(("Kitty", "You owe €20,00 and R 150,00 across 2 groups", "kitty://groups", ""), (s.Title, s.Body, s.Link, s.GroupId));
    }

    [Fact]
    public async Task Weekly_summaries_are_queued_once_per_week()
    {
        var (_, friend) = await DebtsAsync();

        await AsPulse.QueueWeeklySummariesAsync(new QueueWeeklySummariesRequest { Week = "2026-W49" }, cancellationToken: Ct);
        await AsPulse.QueueWeeklySummariesAsync(new QueueWeeklySummariesRequest { Week = "2026-W49" }, cancellationToken: Ct);
        await AsPulse.QueueWeeklySummariesAsync(new QueueWeeklySummariesRequest { Week = "2026-W50" }, cancellationToken: Ct);

        Assert.Equal(2, (await SummariesForAsync(friend)).Count); // one for each week
    }

    [Fact]
    public async Task No_summary_for_someone_who_owes_nothing()
    {
        var (owner, _) = await DebtsAsync();

        await AsPulse.QueueWeeklySummariesAsync(new QueueWeeklySummariesRequest { Week = "2026-W51" }, cancellationToken: Ct);

        Assert.Empty(await SummariesForAsync(owner)); // the owner is owed, not owing
    }

    [Fact]
    public async Task A_bad_week_is_invalid_argument()
    {
        var e = await Assert.ThrowsAsync<RpcException>(() =>
            AsPulse.QueueWeeklySummariesAsync(new QueueWeeklySummariesRequest { Week = "next week" }, cancellationToken: Ct).ResponseAsync);
        Assert.Equal(StatusCode.InvalidArgument, e.StatusCode);
    }

    [Fact]
    public async Task Forget_device_removes_and_republishes()
    {
        var phone = factory.CreateClient();
        phone.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
            TestTokens.For($"sub-{Guid.NewGuid()}", "Phone owner", "p@example.com"));
        var me = await phone.MeAsync();
        var token = $"dead-{Guid.NewGuid()}";
        (await phone.PostJsonAsync("/me/devices", new { token, platform = "android" })).EnsureSuccessStatusCode();

        await AsPulse.ForgetDeviceAsync(new ForgetDeviceRequest { Token = token }, cancellationToken: Ct);
        await AsPulse.ForgetDeviceAsync(new ForgetDeviceRequest { Token = token }, cancellationToken: Ct); // idempotent

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<LedgerDbContext>();
        Assert.False(await db.PushDevices.AnyAsync(d => d.Token == token, Ct));
        var latest = await db.OutboxMessages.Where(m => m.Topic == "ledger.notify-settings" && m.Key == me.Id.ToString())
            .OrderByDescending(m => m.OccurredAt).ThenByDescending(m => m.Id).Select(m => m.Payload).FirstAsync(Ct);
        Assert.Empty(NotifySettingsChanged.Parser.ParseFrom(latest).PushTokens);
    }

    [Fact]
    public async Task A_user_token_is_permission_denied()
    {
        var asUser = Pulse(TestTokens.For($"sub-{Guid.NewGuid()}", "Mallory", "m@example.com"));
        var e = await Assert.ThrowsAsync<RpcException>(() =>
            asUser.QueueWeeklySummariesAsync(new QueueWeeklySummariesRequest { Week = "2026-W48" }, cancellationToken: Ct).ResponseAsync);
        Assert.Equal(StatusCode.PermissionDenied, e.StatusCode);
    }
}
