using System.Net;
using System.Net.Http.Headers;
using Kitty.Contracts.Notify.V1;
using Kitty.Ledger.Data;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;

namespace Kitty.Ledger.IntegrationTests;

[Collection(ApiCollection.Name)]
public class ReminderTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed record Env(WebApplicationFactory<Program> App, FakeTimeProvider Clock, HttpClient Owner, HttpClient Friend,
        HttpClient Third, Guid G, Guid OwnerM, Guid FriendM, Guid ThirdM, Guid FriendU) : IDisposable
    {
        public void Dispose() => App.Dispose();
    }

    /// <summary>"Flat 4B": the owner, a friend and a third member, all with accounts. Nobody owes anything yet.</summary>
    private async Task<Env> GroupAsync()
    {
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 11, 25, 10, 0, 0, TimeSpan.Zero));
        var app = factory.WithWebHostBuilder(b => b.ConfigureTestServices(s => s.AddSingleton<TimeProvider>(clock)));
        HttpClient User(string name)
        {
            var c = app.CreateClient();
            c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
                TestTokens.For($"sub-{Guid.NewGuid()}", name, $"{name.ToLowerInvariant()}-{Guid.NewGuid():N}@example.com"));
            return c;
        }
        var owner = User("Owner");
        var friend = User("Friend");
        var third = User("Third");
        var g = await owner.CreateGroupAsync("Flat 4B");
        await friend.JoinAsync(owner, g.Id);
        var joined = await third.JoinAsync(owner, g.Id);
        Guid M(string n) => joined.Members.Single(m => m.DisplayName == n).Id;
        return new Env(app, clock, owner, friend, third, g.Id, M("Owner"), M("Friend"), M("Third"), (await friend.MeAsync()).Id);
    }

    private static Task<HttpResponseMessage> RemindAsync(HttpClient c, Guid g, Guid member) =>
        c.PostJsonAsync($"/groups/{g}/reminders", new { memberId = member });

    private async Task<List<NotificationRequested>> RemindersForAsync(Env env, Guid userId)
    {
        using var scope = env.App.Services.CreateScope();
        var rows = await scope.ServiceProvider.GetRequiredService<LedgerDbContext>().OutboxMessages
            .Where(m => m.Topic == "notifications.requested" && m.Key == userId.ToString()).Select(m => m.Payload).ToListAsync(Ct);
        return rows.Select(NotificationRequested.Parser.ParseFrom).Where(r => r.Kind == NotificationRequested.Types.Kind.Reminder).ToList();
    }

    private static async Task<string> CodeAsync(HttpResponseMessage r) => (await r.ReadAsync<ProblemBody>()).Code;

    private sealed record ProblemBody(string Code);

    [Fact]
    public async Task Reminder_tells_the_debtor_what_the_settle_up_plan_says()
    {
        using var env = await GroupAsync();
        await env.Owner.AddEqualAsync(env.G, 30000, env.OwnerM, [env.OwnerM, env.FriendM]); // the friend owes R 150,00

        var r = await RemindAsync(env.Owner, env.G, env.FriendM);

        Assert.Equal(HttpStatusCode.NoContent, r.StatusCode);
        var n = Assert.Single(await RemindersForAsync(env, env.FriendU));
        Assert.Equal(("Flat 4B", "Owner reminded you: you owe them R 150,00", $"kitty://groups/{env.G}"), (n.Title, n.Body, n.Link));
    }

    [Fact]
    public async Task Reminder_lists_every_currency_owed()
    {
        using var env = await GroupAsync();
        factory.Fx.Set("EUR", "ZAR", new DateOnly(2026, 11, 25), 19m);
        await env.Owner.AddEqualAsync(env.G, 30000, env.OwnerM, [env.OwnerM, env.FriendM]);
        await env.Owner.AddEqualAsync(env.G, 4000, env.OwnerM, [env.OwnerM, env.FriendM], currency: "EUR");

        (await RemindAsync(env.Owner, env.G, env.FriendM)).EnsureSuccessStatusCode();

        var n = Assert.Single(await RemindersForAsync(env, env.FriendU));
        Assert.Equal("Owner reminded you: you owe them €20,00 and R 150,00", n.Body);
    }

    [Fact]
    public async Task Nothing_owed_is_409()
    {
        using var env = await GroupAsync();

        var r = await RemindAsync(env.Owner, env.G, env.FriendM);

        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.Equal("nothing_owed", await CodeAsync(r));
    }

    [Fact]
    public async Task A_placeholder_cannot_be_reminded()
    {
        using var env = await GroupAsync();
        var gran = await env.Owner.AddPlaceholderAsync(env.G, "Gran");
        await env.Owner.AddEqualAsync(env.G, 20000, env.OwnerM, [env.OwnerM, gran.Id]);

        var r = await RemindAsync(env.Owner, env.G, gran.Id);

        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.Equal("no_account", await CodeAsync(r));
    }

    [Fact]
    public async Task Twice_a_day_is_429_but_another_creditor_may_remind()
    {
        using var env = await GroupAsync();
        // The friend owes the owner R 100,00 and the third member R 100,00.
        await env.Owner.AddEqualAsync(env.G, 30000, env.OwnerM, [env.OwnerM, env.FriendM, env.ThirdM]);
        await env.Third.AddEqualAsync(env.G, 30000, env.ThirdM, [env.OwnerM, env.FriendM, env.ThirdM]);

        Assert.Equal(HttpStatusCode.NoContent, (await RemindAsync(env.Owner, env.G, env.FriendM)).StatusCode);
        var again = await RemindAsync(env.Owner, env.G, env.FriendM);
        Assert.Equal(HttpStatusCode.TooManyRequests, again.StatusCode);
        Assert.Equal("already_reminded", await CodeAsync(again));
        Assert.Equal(HttpStatusCode.NoContent, (await RemindAsync(env.Third, env.G, env.FriendM)).StatusCode);

        env.Clock.Advance(TimeSpan.FromDays(1));
        Assert.Equal(HttpStatusCode.NoContent, (await RemindAsync(env.Owner, env.G, env.FriendM)).StatusCode);
    }

    [Fact]
    public async Task Someone_outside_the_group_gets_404()
    {
        using var env = await GroupAsync();
        await env.Owner.AddEqualAsync(env.G, 30000, env.OwnerM, [env.OwnerM, env.FriendM]);
        var stranger = env.App.CreateClient();
        stranger.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
            TestTokens.For($"sub-{Guid.NewGuid()}", "Stranger", "stranger@example.com"));

        Assert.Equal(HttpStatusCode.NotFound, (await RemindAsync(stranger, env.G, env.FriendM)).StatusCode);
    }
}
