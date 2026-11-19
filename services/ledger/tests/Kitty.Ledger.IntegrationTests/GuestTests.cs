using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;

namespace Kitty.Ledger.IntegrationTests;

public sealed record GuestJoinDto(Guid GuestId, string GuestToken, DateTimeOffset ExpiresAt);

[Collection(ApiCollection.Name)]
public class GuestTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private readonly Guid Burger = Guid.NewGuid(), Salad = Guid.NewGuid();

    private async Task<(HttpClient Host, GroupDto Group, Guid HostMember, TableSessionDto Session)> TableAsync(HttpClient? host = null, bool withItems = true)
    {
        host ??= factory.NewUser("Host");
        var g = await host.CreateGroupAsync();
        var s = await host.CreateSessionAsync(g.Id, g.Members[0].Id);
        if (withItems)
            (await host.PutItemsAsync(g.Id, s.Id, (Burger, "Burger", 12000), (Salad, "Salad", 8000))).EnsureSuccessStatusCode();
        return (host, g, g.Members[0].Id, s);
    }

    private static HttpClient AsGuest(HttpClient anonymous, string token)
    {
        anonymous.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Guest", token);
        return anonymous;
    }

    private static async Task<GuestJoinDto> JoinAsync(HttpClient anonymous, Guid sessionId, string name = "Zoe")
    {
        var r = await anonymous.PostAsJsonAsync($"/table-sessions/{sessionId}/join", new { displayName = name }, Ct);
        r.EnsureSuccessStatusCode();
        return await r.ReadAsync<GuestJoinDto>();
    }

    [Fact]
    public async Task Guest_can_join_view_and_claim()
    {
        var (host, g, _, s) = await TableAsync();
        var join = await JoinAsync(factory.CreateClient(), s.Id);
        Assert.Equal(43, join.GuestToken.Length);
        var guest = AsGuest(factory.CreateClient(), join.GuestToken);

        var view = (await guest.GetFromJsonAsync<TableSessionDto>($"/guest/table-sessions/{s.Id}", ApiClientExtensions.Json, Ct))!;
        Assert.Equal(2, view.Items.Count);

        Assert.Equal(HttpStatusCode.NoContent, (await guest.PutAsync($"/guest/table-sessions/{s.Id}/items/{Burger}/claim", null, Ct)).StatusCode);
        var hostView = await host.GetSessionAsync(g.Id, s.Id);
        var claimant = Assert.Single(hostView.Items.Single(i => i.Id == Burger).Claimants);
        Assert.Equal(("guest", "Zoe"), (claimant.Kind, claimant.DisplayName));
    }

    [Fact]
    public async Task Guest_view_names_the_guest_and_follows_the_hosts_mapping()
    {
        var (host, g, _, s) = await TableAsync();
        var gran = await host.AddPlaceholderAsync(g.Id, "Gran");
        var join = await JoinAsync(factory.CreateClient(), s.Id, "Gran's phone");
        var guest = AsGuest(factory.CreateClient(), join.GuestToken);
        (await guest.PutAsync($"/guest/table-sessions/{s.Id}/items/{Salad}/claim", null, Ct)).EnsureSuccessStatusCode();
        (await host.ClaimAsync(g.Id, s.Id, Burger)).EnsureSuccessStatusCode(); // nothing left unclaimed, so the salad is the guest's whole share

        var before = (await guest.GetFromJsonAsync<TableSessionDto>($"/guest/table-sessions/{s.Id}", ApiClientExtensions.Json, Ct))!;
        Assert.Equal(new TableViewerDto("guest", join.GuestId), before.Viewer);
        Assert.Equal("Host", before.PayerDisplayName);

        (await host.PostJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/guests/{join.GuestId}/map", new { memberId = gran.Id })).EnsureSuccessStatusCode();

        // Once matched to Gran, the guest's own screen must still recognise their claims and share.
        var after = (await guest.GetFromJsonAsync<TableSessionDto>($"/guest/table-sessions/{s.Id}", ApiClientExtensions.Json, Ct))!;
        Assert.Equal(new TableViewerDto("member", gran.Id), after.Viewer);
        Assert.Equal(after.Viewer.Id, Assert.Single(after.Items.Single(i => i.Id == Salad).Claimants).Id);
        Assert.Equal(8000, after.Preview.Single(p => p.Id == after.Viewer.Id).AmountMinor);
    }

    [Fact]
    public async Task Guest_token_is_scoped_to_one_session()
    {
        var (_, _, _, s) = await TableAsync();
        var (_, _, _, other) = await TableAsync(withItems: false);
        var join = await JoinAsync(factory.CreateClient(), s.Id);
        var guest = AsGuest(factory.CreateClient(), join.GuestToken);

        Assert.Equal(HttpStatusCode.NotFound, (await guest.GetAsync($"/guest/table-sessions/{other.Id}", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound,
            (await guest.PutAsync($"/guest/table-sessions/{other.Id}/items/{Guid.NewGuid()}/claim", null, Ct)).StatusCode);
    }

    [Fact]
    public async Task Guest_token_rejected_after_confirm()
    {
        var (host, g, hostMember, s) = await TableAsync();
        var join = await JoinAsync(factory.CreateClient(), s.Id);
        var guest = AsGuest(factory.CreateClient(), join.GuestToken);
        (await host.ClaimAsync(g.Id, s.Id, Burger)).EnsureSuccessStatusCode();
        (await host.PostJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/confirm", new { })).EnsureSuccessStatusCode();

        Assert.Equal(HttpStatusCode.NotFound, (await guest.GetAsync($"/guest/table-sessions/{s.Id}", Ct)).StatusCode);
    }

    [Fact]
    public async Task Guest_token_rejected_after_24h()
    {
        var clock = new FakeTimeProvider(DateTimeOffset.UtcNow);
        using var later = factory.WithWebHostBuilder(b => b.ConfigureTestServices(sv => sv.AddSingleton<TimeProvider>(clock)));
        var host = later.CreateClient();
        host.DefaultRequestHeaders.Authorization = new("Bearer", TestTokens.For($"sub-{Guid.NewGuid()}", "Host", "h@example.com"));
        var (_, _, _, s) = await TableAsync(host);
        var join = await JoinAsync(later.CreateClient(), s.Id);

        clock.Advance(TimeSpan.FromHours(25));
        var guest = AsGuest(later.CreateClient(), join.GuestToken);
        Assert.Equal(HttpStatusCode.NotFound, (await guest.GetAsync($"/guest/table-sessions/{s.Id}", Ct)).StatusCode);
    }

    [Fact]
    public async Task Guest_cannot_call_group_routes()
    {
        var (_, g, _, s) = await TableAsync();
        var join = await JoinAsync(factory.CreateClient(), s.Id);
        var guest = AsGuest(factory.CreateClient(), join.GuestToken);

        Assert.Equal(HttpStatusCode.Unauthorized, (await guest.GetAsync($"/groups/{g.Id}", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await guest.GetAsync($"/groups/{g.Id}/balances", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await guest.GetAsync($"/groups/{g.Id}/table-sessions/{s.Id}", Ct)).StatusCode);
    }

    [Fact]
    public async Task Guest_view_hides_payment_details()
    {
        var (host, g, hostMember, s) = await TableAsync();
        (await host.PatchJsonAsync($"/groups/{g.Id}/members/{hostMember}", new { paymentDetails = "Account 12345" })).EnsureSuccessStatusCode();
        var join = await JoinAsync(factory.CreateClient(), s.Id);
        var body = await AsGuest(factory.CreateClient(), join.GuestToken).GetStringAsync($"/guest/table-sessions/{s.Id}", Ct);

        Assert.DoesNotContain("12345", body);
        Assert.DoesNotContain("paymentDetails", body, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Garbage_token_is_rejected()
    {
        var (_, _, _, s) = await TableAsync();
        var guest = AsGuest(factory.CreateClient(), "not-a-real-token");
        Assert.Equal(HttpStatusCode.NotFound, (await guest.GetAsync($"/guest/table-sessions/{s.Id}", Ct)).StatusCode);
    }

    [Fact]
    public async Task Joining_a_locked_session_returns_409()
    {
        var (host, g, _, s) = await TableAsync();
        (await host.PostJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/lock", new { })).EnsureSuccessStatusCode();
        var r = await factory.CreateClient().PostAsJsonAsync($"/table-sessions/{s.Id}/join", new { displayName = "Late" }, Ct);
        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
    }

    [Fact]
    public async Task Mapped_guest_claims_count_for_the_member_on_confirm()
    {
        var (host, g, _, s) = await TableAsync();
        var gran = await host.AddPlaceholderAsync(g.Id, "Gran");
        var join = await JoinAsync(factory.CreateClient(), s.Id, "Gran's phone");
        var guest = AsGuest(factory.CreateClient(), join.GuestToken);
        (await guest.PutAsync($"/guest/table-sessions/{s.Id}/items/{Salad}/claim", null, Ct)).EnsureSuccessStatusCode();
        (await host.ClaimAsync(g.Id, s.Id, Burger)).EnsureSuccessStatusCode();

        var unmapped = await host.PostJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/confirm", new { });
        Assert.Equal("guests_unmapped", await unmapped.ReadCodeAsync());

        (await host.PostJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/guests/{join.GuestId}/map", new { memberId = gran.Id })).EnsureSuccessStatusCode();
        var confirmed = await (await host.PostJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/confirm", new { })).ReadAsync<TableSessionDto>();
        var expense = (await host.GetFromJsonAsync<ExpenseDto>($"/groups/{g.Id}/expenses/{confirmed.ExpenseId}", ApiClientExtensions.Json, Ct))!;
        Assert.Equal(8000, expense.Shares.Single(x => x.MemberId == gran.Id).AmountMinor);
    }

    [Fact]
    public async Task Concurrent_joins_never_exceed_the_guest_cap()
    {
        var (_, _, _, s) = await TableAsync();
        using var roomy = factory.WithWebHostBuilder(b => b.UseSetting("Ledger:GuestJoinsPerMinute", "1000"));
        var results = await Task.WhenAll(Enumerable.Range(0, 45).Select(i =>
            roomy.CreateClient().PostAsJsonAsync($"/table-sessions/{s.Id}/join", new { displayName = $"G{i}" }, Ct)));

        Assert.Equal(30, results.Count(r => r.StatusCode == HttpStatusCode.Created));
        Assert.All(results.Where(r => r.StatusCode != HttpStatusCode.Created), r => Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode));
    }

    [Fact]
    public async Task Varying_whitespace_does_not_reset_the_guest_claim_limit()
    {
        var (_, _, _, s) = await TableAsync();
        using var limited = factory.WithWebHostBuilder(b => b.UseSetting("Ledger:GuestClaimsPerMinute", "2"));
        var join = await JoinAsync(limited.CreateClient(), s.Id);

        async Task<HttpStatusCode> ClaimWith(string header)
        {
            var request = new HttpRequestMessage(HttpMethod.Put, $"/guest/table-sessions/{s.Id}/items/{Burger}/claim");
            request.Headers.TryAddWithoutValidation("Authorization", header);
            return (await limited.CreateClient().SendAsync(request, Ct)).StatusCode;
        }

        Assert.Equal(HttpStatusCode.NoContent, await ClaimWith($"Guest {join.GuestToken}"));
        Assert.Equal(HttpStatusCode.NoContent, await ClaimWith($"Guest  {join.GuestToken}"));
        Assert.Equal(HttpStatusCode.TooManyRequests, await ClaimWith($"Guest {join.GuestToken}   "));
    }

    [Fact]
    public async Task Join_is_rate_limited()
    {
        var (_, _, _, s) = await TableAsync();
        using var limited = factory.WithWebHostBuilder(b => b.UseSetting("Ledger:GuestJoinsPerMinute", "2"));
        var anonymous = limited.CreateClient();
        for (var i = 0; i < 2; i++)
            (await anonymous.PostAsJsonAsync($"/table-sessions/{s.Id}/join", new { displayName = $"G{i}" }, Ct)).EnsureSuccessStatusCode();

        var r = await anonymous.PostAsJsonAsync($"/table-sessions/{s.Id}/join", new { displayName = "One too many" }, Ct);
        Assert.Equal(HttpStatusCode.TooManyRequests, r.StatusCode);
    }

    [Fact]
    public async Task Behind_the_proxy_each_client_ip_gets_its_own_join_limit()
    {
        // In production every join arrives from the web server, which passes on the client address.
        var (_, _, _, s) = await TableAsync();
        using var proxied = factory.WithWebHostBuilder(b => b
            .UseSetting("Ledger:TrustForwardedHeaders", "true")
            .UseSetting("Ledger:GuestJoinsPerMinute", "1"));
        var web = proxied.CreateClient();

        Task<HttpResponseMessage> JoinFrom(string ip, string name)
        {
            var request = new HttpRequestMessage(HttpMethod.Post, $"/table-sessions/{s.Id}/join")
            {
                Content = JsonContent.Create(new { displayName = name }),
            };
            request.Headers.Add("X-Forwarded-For", ip);
            return web.SendAsync(request, Ct);
        }

        Assert.Equal(HttpStatusCode.Created, (await JoinFrom("203.0.113.1", "A")).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await JoinFrom("203.0.113.1", "B")).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await JoinFrom("203.0.113.2", "C")).StatusCode);
    }
}
