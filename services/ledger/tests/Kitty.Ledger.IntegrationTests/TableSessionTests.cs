using System.Net;
using System.Net.Http.Json;

namespace Kitty.Ledger.IntegrationTests;

public sealed record ClaimantDto(string Kind, Guid Id, string DisplayName);
public sealed record TableItemDto(Guid Id, string Description, int Quantity, long LineTotalMinor, List<ClaimantDto> Claimants);
public sealed record TableChargeDto(Guid Id, string Kind, long AmountMinor);
public sealed record TableGuestDto(Guid Id, string DisplayName, Guid? MappedMemberId);
public sealed record PreviewShareDto(string Kind, Guid Id, string DisplayName, long AmountMinor);
public sealed record TableViewerDto(string Kind, Guid Id);
public sealed record TableSessionDto(Guid Id, string Title, string Currency, string Status, int Version, Guid PayerMemberId,
    string PayerDisplayName, Guid? ExpenseId, TableViewerDto Viewer, List<TableItemDto> Items, List<TableChargeDto> Charges,
    List<TableGuestDto> Guests, List<PreviewShareDto> Preview);

public static class TableData
{
    public static async Task<TableSessionDto> CreateSessionAsync(this HttpClient host, Guid groupId, Guid payerMemberId, string title = "Dinner")
    {
        var r = await host.PostJsonAsync($"/groups/{groupId}/table-sessions",
            new { id = Guid.NewGuid(), title, currency = "ZAR", payerMemberId });
        r.EnsureSuccessStatusCode();
        return await r.ReadAsync<TableSessionDto>();
    }

    public static Task<HttpResponseMessage> PutItemsAsync(this HttpClient c, Guid groupId, Guid sessionId, params (Guid Id, string Name, long Minor)[] items) =>
        c.PutJsonAsync($"/groups/{groupId}/table-sessions/{sessionId}/items",
            new { items = items.Select(i => new { id = i.Id, description = i.Name, quantity = 1, lineTotalMinor = i.Minor }) });

    public static Task<HttpResponseMessage> ClaimAsync(this HttpClient c, Guid groupId, Guid sessionId, Guid itemId) =>
        c.PutJsonAsync($"/groups/{groupId}/table-sessions/{sessionId}/items/{itemId}/claim", new { });

    public static async Task<TableSessionDto> GetSessionAsync(this HttpClient c, Guid groupId, Guid sessionId) =>
        (await c.GetFromJsonAsync<TableSessionDto>($"/groups/{groupId}/table-sessions/{sessionId}", ApiClientExtensions.Json,
            TestContext.Current.CancellationToken))!;
}

[Collection(ApiCollection.Name)]
public class TableSessionTests(LedgerApiFactory factory)
{
    private readonly Guid Burger = Guid.NewGuid(), Salad = Guid.NewGuid(), Fries = Guid.NewGuid(); // per test: item ids are primary keys

    private async Task<(HttpClient Host, HttpClient Friend, GroupDto Group, Guid HostMember, Guid FriendMember, TableSessionDto Session)> TableAsync()
    {
        var host = factory.NewUser("Host");
        var g = await host.CreateGroupAsync();
        var friend = factory.NewUser("Friend");
        var joined = await friend.JoinAsync(host, g.Id);
        var hostMember = joined.Members.Single(m => m.DisplayName == "Host").Id;
        var friendMember = joined.Members.Single(m => m.DisplayName == "Friend").Id;
        var s = await host.CreateSessionAsync(g.Id, hostMember);
        (await host.PutItemsAsync(g.Id, s.Id, (Burger, "Burger", 12000), (Salad, "Salad", 8000), (Fries, "Fries", 3000))).EnsureSuccessStatusCode();
        return (host, friend, joined, hostMember, friendMember, s);
    }

    [Fact]
    public async Task Members_claim_and_preview_updates()
    {
        var (host, friend, g, hostMember, friendMember, s) = await TableAsync();
        (await host.ClaimAsync(g.Id, s.Id, Burger)).EnsureSuccessStatusCode();
        (await friend.ClaimAsync(g.Id, s.Id, Salad)).EnsureSuccessStatusCode();
        (await friend.ClaimAsync(g.Id, s.Id, Fries)).EnsureSuccessStatusCode();
        (await host.ClaimAsync(g.Id, s.Id, Fries)).EnsureSuccessStatusCode();

        var view = await friend.GetSessionAsync(g.Id, s.Id);
        Assert.Equal(2, view.Items.Single(i => i.Id == Fries).Claimants.Count);
        Assert.Equal(13500, view.Preview.Single(p => p.Id == hostMember).AmountMinor);  // 12000 + 1500
        Assert.Equal(9500, view.Preview.Single(p => p.Id == friendMember).AmountMinor); // 8000 + 1500
        Assert.True(view.Version > s.Version);
    }

    [Fact]
    public async Task Session_tells_each_viewer_who_they_are_and_who_is_paying()
    {
        var (host, friend, g, hostMember, friendMember, s) = await TableAsync();
        var hostView = await host.GetSessionAsync(g.Id, s.Id);
        var friendView = await friend.GetSessionAsync(g.Id, s.Id);

        Assert.Equal(new TableViewerDto("member", hostMember), hostView.Viewer);
        Assert.Equal(new TableViewerDto("member", friendMember), friendView.Viewer);
        Assert.Equal("Host", friendView.PayerDisplayName);
    }

    [Fact]
    public async Task Item_id_already_used_on_another_bill_returns_409_not_500()
    {
        var (host, _, g, hostMember, _, _) = await TableAsync(); // this bill owns Burger
        var other = await host.CreateSessionAsync(g.Id, hostMember, "Second bill");

        var r = await host.PutItemsAsync(g.Id, other.Id, (Burger, "Copied burger", 100));
        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.Equal("already_exists", await r.ReadCodeAsync());
        Assert.Empty((await host.GetSessionAsync(g.Id, other.Id)).Items);
    }

    [Fact]
    public async Task Replacing_charges_with_the_same_id_updates_them()
    {
        var (host, _, g, _, _, s) = await TableAsync();
        var tipId = Guid.NewGuid();
        Task<HttpResponseMessage> PutTip(long amount) => host.PutJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/charges",
            new { charges = new[] { new { id = tipId, kind = "tip", amountMinor = amount } } });

        (await PutTip(1000)).EnsureSuccessStatusCode();
        var second = await PutTip(2500);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        var charge = Assert.Single((await second.ReadAsync<TableSessionDto>()).Charges);
        Assert.Equal((tipId, 2500L), (charge.Id, charge.AmountMinor));
    }

    [Fact]
    public async Task Lock_and_unlock_are_audited()
    {
        var (host, _, g, _, _, s) = await TableAsync();
        (await host.PostJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/lock", new { })).EnsureSuccessStatusCode();
        (await host.PostJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/unlock", new { })).EnsureSuccessStatusCode();

        var feed = (await host.GetFromJsonAsync<List<ActivityDto>>($"/groups/{g.Id}/activity", ApiClientExtensions.Json,
            TestContext.Current.CancellationToken))!;
        var statuses = feed.Where(a => a.EntityType == "table_session" && a.After?.TryGetProperty("status", out _) == true)
            .Select(a => a.After!.Value.GetProperty("status").GetString()).ToList();
        Assert.Equal(["open", "locked"], statuses); // newest first
    }

    [Fact]
    public async Task Claiming_twice_is_harmless_and_unclaim_removes_it()
    {
        var (host, _, g, _, _, s) = await TableAsync();
        (await host.ClaimAsync(g.Id, s.Id, Burger)).EnsureSuccessStatusCode();
        (await host.ClaimAsync(g.Id, s.Id, Burger)).EnsureSuccessStatusCode();
        Assert.Single((await host.GetSessionAsync(g.Id, s.Id)).Items.Single(i => i.Id == Burger).Claimants);

        (await host.DeleteAsync($"/groups/{g.Id}/table-sessions/{s.Id}/items/{Burger}/claim", key: null)).EnsureSuccessStatusCode();
        Assert.Empty((await host.GetSessionAsync(g.Id, s.Id)).Items.Single(i => i.Id == Burger).Claimants);
    }

    [Fact]
    public async Task Concurrent_claims_on_one_item_both_survive()
    {
        var (host, friend, g, _, _, s) = await TableAsync();
        var results = await Task.WhenAll(
            Enumerable.Range(0, 5).SelectMany(_ => new[] { host.ClaimAsync(g.Id, s.Id, Fries), friend.ClaimAsync(g.Id, s.Id, Fries) }));
        Assert.All(results, r => Assert.True(r.IsSuccessStatusCode, $"claim returned {(int)r.StatusCode}"));
        Assert.Equal(2, (await host.GetSessionAsync(g.Id, s.Id)).Items.Single(i => i.Id == Fries).Claimants.Count);
    }

    [Fact]
    public async Task Claim_after_lock_returns_409()
    {
        var (host, friend, g, _, _, s) = await TableAsync();
        (await host.PostJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/lock", new { })).EnsureSuccessStatusCode();
        var r = await friend.ClaimAsync(g.Id, s.Id, Salad);
        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.Equal("session_locked", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Non_host_cannot_edit_items_or_confirm()
    {
        var (_, friend, g, _, _, s) = await TableAsync();
        var edit = await friend.PutItemsAsync(g.Id, s.Id, (Burger, "Free burger", 0));
        Assert.Equal(HttpStatusCode.Forbidden, edit.StatusCode);
        Assert.Equal("host_only", await edit.ReadCodeAsync());
        Assert.Equal(HttpStatusCode.Forbidden, (await friend.PostJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/confirm", new { })).StatusCode);
    }

    [Fact]
    public async Task Confirm_creates_one_itemized_expense_and_balances_update()
    {
        var (host, friend, g, hostMember, friendMember, s) = await TableAsync();
        (await host.PutJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/charges",
            new { charges = new[] { new { id = Guid.NewGuid(), kind = "tip", amountMinor = 2300 } } })).EnsureSuccessStatusCode();
        (await host.ClaimAsync(g.Id, s.Id, Burger)).EnsureSuccessStatusCode();
        (await friend.ClaimAsync(g.Id, s.Id, Salad)).EnsureSuccessStatusCode();
        // Fries unclaimed: shared by both.

        var confirmed = await (await host.PostJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/confirm", new { })).ReadAsync<TableSessionDto>();
        Assert.Equal("confirmed", confirmed.Status);
        Assert.NotNull(confirmed.ExpenseId);

        var expense = (await host.GetFromJsonAsync<ExpenseDto>($"/groups/{g.Id}/expenses/{confirmed.ExpenseId}", ApiClientExtensions.Json,
            TestContext.Current.CancellationToken))!;
        Assert.Equal("itemized", expense.Split.Method);
        Assert.Equal(25300, expense.AmountMinor); // 23000 items + 2300 tip
        Assert.Equal(25300, expense.Shares.Sum(x => x.AmountMinor));
        Assert.Equal(hostMember, Assert.Single(expense.Payers).MemberId);
        // Host: 12000 + 1500 = 13500 → tip 2300 × 13500/23000 = 1350; friend 9500 → 950
        Assert.Equal(14850, expense.Shares.Single(x => x.MemberId == hostMember).AmountMinor);
        Assert.Equal(10450, expense.Shares.Single(x => x.MemberId == friendMember).AmountMinor);

        var balances = (await host.GetFromJsonAsync<BalancesDto>($"/groups/{g.Id}/balances", ApiClientExtensions.Json,
            TestContext.Current.CancellationToken))!;
        Assert.Equal(-10450, balances.Currencies.Single().Members.Single(m => m.MemberId == friendMember).NetMinor);
    }

    [Fact]
    public async Task Confirm_twice_returns_same_expense()
    {
        var (host, _, g, _, _, s) = await TableAsync();
        (await host.ClaimAsync(g.Id, s.Id, Burger)).EnsureSuccessStatusCode();
        var first = await (await host.PostJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/confirm", new { })).ReadAsync<TableSessionDto>();
        var second = await (await host.PostJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/confirm", new { })).ReadAsync<TableSessionDto>();
        Assert.Equal(first.ExpenseId, second.ExpenseId);

        var page = (await host.GetFromJsonAsync<ExpensePageDto>($"/groups/{g.Id}/expenses", ApiClientExtensions.Json,
            TestContext.Current.CancellationToken))!;
        Assert.Single(page.Items);
    }

    [Fact]
    public async Task Confirm_with_nobody_claiming_returns_400()
    {
        var (host, _, g, _, _, s) = await TableAsync();
        var r = await host.PostJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/confirm", new { });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
    }

    [Fact]
    public async Task Cancelled_session_rejects_claims()
    {
        var (host, friend, g, _, _, s) = await TableAsync();
        (await host.PostJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/cancel", new { })).EnsureSuccessStatusCode();
        var r = await friend.ClaimAsync(g.Id, s.Id, Burger);
        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.Equal("session_closed", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Invalid_items_are_rejected()
    {
        var (host, _, g, _, _, s) = await TableAsync();
        var r = await host.PutItemsAsync(g.Id, s.Id, (Guid.NewGuid(), "", 100));
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        var negative = await host.PutItemsAsync(g.Id, s.Id, (Guid.NewGuid(), "Refund", -100));
        Assert.Equal(HttpStatusCode.BadRequest, negative.StatusCode);
    }

    [Fact]
    public async Task Non_member_gets_404()
    {
        var (_, _, g, _, _, s) = await TableAsync();
        var stranger = factory.NewUser("Eve");
        Assert.Equal(HttpStatusCode.NotFound,
            (await stranger.GetAsync($"/groups/{g.Id}/table-sessions/{s.Id}", TestContext.Current.CancellationToken)).StatusCode);
    }
}
