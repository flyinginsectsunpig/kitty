using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;

namespace Kitty.Ledger.IntegrationTests;

[Collection(ApiCollection.Name)]
public class InviteTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Add_placeholder_then_invite_claims_it()
    {
        var owner = factory.NewUser("Owner");
        var g = await owner.CreateGroupAsync();
        var gran = await owner.AddPlaceholderAsync(g.Id, "Gran");
        Assert.True(gran.IsPlaceholder);

        var invite = await owner.CreateInviteAsync(g.Id, gran.Id);
        Assert.Equal(43, invite.Token.Length);

        var invitee = factory.NewUser("Real Gran");
        var preview = (await invitee.GetFromJsonAsync<InvitePreviewDto>($"/invites/{invite.Token}", Ct))!;
        Assert.Equal("Gran", preview.PlaceholderName);

        var accepted = await (await invitee.PostJsonAsync($"/invites/{invite.Token}/accept", new { })).ReadAsync<GroupDto>();
        var claimed = accepted.Members.Single(m => m.Id == gran.Id);
        Assert.Equal((await invitee.MeAsync()).Id, claimed.UserId);
        Assert.False(claimed.IsPlaceholder);
        Assert.Equal(2, accepted.Members.Count);
    }

    [Fact]
    public async Task Creating_an_invite_is_audited_without_the_token()
    {
        var owner = factory.NewUser("Owner");
        var g = await owner.CreateGroupAsync();
        var invite = await owner.CreateInviteAsync(g.Id);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<Kitty.Ledger.Data.LedgerDbContext>();
        var entry = Assert.Single(db.AuditEntries.Where(a => a.GroupId == g.Id && a.EntityType == "invite").ToList());
        Assert.Equal("created", entry.Action);
        Assert.DoesNotContain(invite.Token, entry.After ?? "");
    }

    [Fact]
    public async Task Open_invite_adds_a_new_member()
    {
        var owner = factory.NewUser("Owner");
        var g = await owner.CreateGroupAsync();
        var joined = await factory.NewUser("Sipho").JoinAsync(owner, g.Id);
        Assert.Contains(joined.Members, m => m.DisplayName == "Sipho" && !m.IsPlaceholder);
    }

    [Fact]
    public async Task Accept_used_invite_returns_409()
    {
        var owner = factory.NewUser();
        var g = await owner.CreateGroupAsync();
        var invite = await owner.CreateInviteAsync(g.Id);
        (await factory.NewUser().PostJsonAsync($"/invites/{invite.Token}/accept", new { })).EnsureSuccessStatusCode();

        var r = await factory.NewUser().PostJsonAsync($"/invites/{invite.Token}/accept", new { });
        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.Equal("invite_used", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Accept_when_already_member_returns_409()
    {
        var owner = factory.NewUser();
        var g = await owner.CreateGroupAsync();
        var invite = await owner.CreateInviteAsync(g.Id);

        var r = await owner.PostJsonAsync($"/invites/{invite.Token}/accept", new { });
        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.Equal("already_member", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Second_invite_for_a_claimed_placeholder_returns_409()
    {
        var owner = factory.NewUser();
        var g = await owner.CreateGroupAsync();
        var gran = await owner.AddPlaceholderAsync(g.Id, "Gran");
        var first = await owner.CreateInviteAsync(g.Id, gran.Id);
        var second = await owner.CreateInviteAsync(g.Id, gran.Id);
        (await factory.NewUser().PostJsonAsync($"/invites/{first.Token}/accept", new { })).EnsureSuccessStatusCode();

        var r = await factory.NewUser().PostJsonAsync($"/invites/{second.Token}/accept", new { });
        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.Equal("placeholder_claimed", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Invite_for_a_real_member_is_rejected()
    {
        var owner = factory.NewUser();
        var g = await owner.CreateGroupAsync();
        var r = await owner.PostJsonAsync($"/groups/{g.Id}/invites", new { memberId = g.Members[0].Id });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal("validation_failed", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Unknown_invite_returns_404() =>
        Assert.Equal(HttpStatusCode.NotFound,
            (await factory.NewUser().GetAsync("/invites/does-not-exist", Ct)).StatusCode);

    [Fact]
    public async Task Expired_invite_returns_409()
    {
        var clock = new FakeTimeProvider(DateTimeOffset.UtcNow);
        using var timeTravel = factory.WithWebHostBuilder(b =>
            b.ConfigureTestServices(s => s.AddSingleton<TimeProvider>(clock)));

        HttpClient Client(string sub)
        {
            var c = timeTravel.CreateClient();
            c.DefaultRequestHeaders.Authorization = new("Bearer", TestTokens.For(sub, sub, $"{sub}@example.com"));
            return c;
        }

        var owner = Client($"sub-{Guid.NewGuid()}");
        var g = await owner.CreateGroupAsync();
        var invite = await owner.CreateInviteAsync(g.Id);

        clock.Advance(TimeSpan.FromDays(8));
        var r = await Client($"sub-{Guid.NewGuid()}").PostJsonAsync($"/invites/{invite.Token}/accept", new { });
        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.Equal("invite_expired", await r.ReadCodeAsync());
    }
}
