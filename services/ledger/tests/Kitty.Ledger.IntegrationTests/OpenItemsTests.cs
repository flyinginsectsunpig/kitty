using System.Net;
using System.Net.Http.Json;

namespace Kitty.Ledger.IntegrationTests;

public sealed record OpenItemDto(ExpenseLineDto Item, MoneyDto Open);
public sealed record OpenItemsCurrencyDto(string Currency, List<OpenItemDto> FromOwes, MoneyDto FromOwesTotal, List<OpenItemDto> ToOwes,
    MoneyDto ToOwesTotal);
public sealed record OpenItemsDto(Guid FromMemberId, Guid ToMemberId, List<OpenItemsCurrencyDto> Currencies);

[Collection(ApiCollection.Name)]
public class OpenItemsTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private static readonly DateOnly On = new(2026, 11, 18);

    /// <summary>Me (the owner) and Joe, in a ZAR group, with the Uber (I owe Joe 2500) and groceries (I owe Joe 9500).</summary>
    private async Task<(HttpClient Owner, Guid G, Guid Me, Guid Joe, Guid Uber)> FlatAsync()
    {
        var owner = factory.NewUser("Owner");
        var joe = factory.NewUser("Joe");
        var g = await owner.CreateGroupAsync("Flat 4B");
        var joined = await joe.JoinAsync(owner, g.Id);
        Guid M(string n) => joined.Members.Single(m => m.DisplayName == n).Id;
        var (me, joeM) = (M("Owner"), M("Joe"));
        var uber = await owner.SpendAsync(g.Id, 5000, joeM, [me, joeM], "Uber", On);
        await owner.SpendAsync(g.Id, 19000, joeM, [me, joeM], "Groceries", On.AddDays(1));
        return (owner, g.Id, me, joeM, uber);
    }

    private static Task<HttpResponseMessage> GetAsync(HttpClient c, Guid g, Guid from, Guid to) =>
        c.GetAsync($"/groups/{g}/open-items?from={from}&to={to}", Ct);

    private static async Task<OpenItemsCurrencyDto> ZarAsync(HttpClient c, Guid g, Guid from, Guid to)
    {
        var r = await GetAsync(c, g, from, to);
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var dto = await r.ReadAsync<OpenItemsDto>();
        Assert.Equal((from, to), (dto.FromMemberId, dto.ToMemberId));
        return Assert.Single(dto.Currencies);
    }

    [Fact]
    public async Task Covered_item_drops_off()
    {
        var (c, g, me, joe, uber) = await FlatAsync();
        (await c.SettleCoveringAsync(g, me, joe, 2500, (uber, 2500))).EnsureSuccessStatusCode();

        var zar = await ZarAsync(c, g, me, joe);

        var groceries = Assert.Single(zar.FromOwes);
        Assert.Equal(("Groceries", 9500L, 9500L), (groceries.Item.Description, groceries.Item.MyShare.Minor, groceries.Open.Minor));
        Assert.Equal(MoneyDto.Of(9500), zar.FromOwesTotal);
        Assert.Empty(zar.ToOwes);
        Assert.Equal(MoneyDto.Of(0), zar.ToOwesTotal);
    }

    [Fact]
    public async Task Part_cover_leaves_the_rest_open()
    {
        var (c, g, me, joe, uber) = await FlatAsync();
        (await c.SettleCoveringAsync(g, me, joe, 1000, (uber, 1000))).EnsureSuccessStatusCode();

        var zar = await ZarAsync(c, g, me, joe);

        Assert.Equal(["Groceries", "Uber"], zar.FromOwes.Select(i => i.Item.Description));
        Assert.Equal(MoneyDto.Of(1500), zar.FromOwes.Single(i => i.Item.ExpenseId == uber).Open);
        Assert.Equal(MoneyDto.Of(11000), zar.FromOwesTotal);
    }

    [Fact]
    public async Task Both_directions_are_listed()
    {
        var (c, g, me, joe, _) = await FlatAsync();
        await c.SpendAsync(g, 6000, me, [me, joe], "Pizza", On.AddDays(2));

        var zar = await ZarAsync(c, g, me, joe);

        var pizza = Assert.Single(zar.ToOwes);
        Assert.Equal(("Pizza", 3000L, 3000L), (pizza.Item.Description, pizza.Item.MyShare.Minor, pizza.Open.Minor));
        Assert.Equal(MoneyDto.Of(3000), zar.ToOwesTotal);
        Assert.Equal(2, zar.FromOwes.Count);
    }

    [Fact]
    public async Task Deleting_a_linked_payment_reopens_its_items()
    {
        var (c, g, me, joe, uber) = await FlatAsync();
        var paid = await (await c.SettleCoveringAsync(g, me, joe, 2500, (uber, 2500))).ReadAsync<CoveringSettlementDto>();
        (await c.DeleteAsync($"/groups/{g}/settlements/{paid.Id}", key: null)).EnsureSuccessStatusCode();

        var zar = await ZarAsync(c, g, me, joe);

        Assert.Equal(MoneyDto.Of(2500), zar.FromOwes.Single(i => i.Item.ExpenseId == uber).Open);
        Assert.Equal(MoneyDto.Of(12000), zar.FromOwesTotal);
    }

    [Fact]
    public async Task Member_not_in_group_is_rejected()
    {
        var (c, g, me, _, _) = await FlatAsync();

        var r = await GetAsync(c, g, me, Guid.NewGuid());

        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal("member_not_in_group", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Same_member_twice_is_rejected()
    {
        var (c, g, me, _, _) = await FlatAsync();

        var r = await GetAsync(c, g, me, me);

        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal("validation_failed", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Edited_share_below_cover_leaves_the_rest_unallocated()
    {
        var (c, g, me, joe, uber) = await FlatAsync();
        (await c.SettleCoveringAsync(g, me, joe, 2500, (uber, 2500))).EnsureSuccessStatusCode();
        (await c.PutJsonAsync($"/groups/{g}/expenses/{uber}",
            ExpenseData.Equal(uber, 2000, joe, [me, joe], description: "Uber", version: 1, on: On))).EnsureSuccessStatusCode();

        var zar = await ZarAsync(c, g, me, joe);

        Assert.DoesNotContain(zar.FromOwes, i => i.Item.ExpenseId == uber);
        var owing = (await c.GetFromJsonAsync<OwingDto>("/me/owing", Ct))!;
        var payment = Assert.Single(Assert.Single(Assert.Single(owing.Groups).Currencies).Payments);
        Assert.Equal(MoneyDto.Of(1500), payment.Unallocated);
    }

    [Fact]
    public async Task Currency_edit_reopens_the_item_and_frees_the_cover()
    {
        var (c, g, me, joe, uber) = await FlatAsync();
        (await c.SettleCoveringAsync(g, me, joe, 2500, (uber, 2500))).EnsureSuccessStatusCode();
        (await c.PutJsonAsync($"/groups/{g}/expenses/{uber}",
            ExpenseData.Equal(uber, 5000, joe, [me, joe], currency: "USD", description: "Uber", version: 1, on: On)))
            .EnsureSuccessStatusCode();

        var r = await GetAsync(c, g, me, joe);
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var dto = await r.ReadAsync<OpenItemsDto>();
        var usd = dto.Currencies.Single(x => x.Currency == "USD");
        var item = Assert.Single(usd.FromOwes);
        Assert.Equal((uber, 2500L), (item.Item.ExpenseId, item.Open.Minor));
        var owing = (await c.GetFromJsonAsync<OwingDto>("/me/owing", Ct))!;
        var zar = Assert.Single(owing.Groups).Currencies.Single(x => x.Currency == "ZAR");
        var payment = Assert.Single(zar.Payments);
        Assert.Equal(MoneyDto.Of(2500), payment.Unallocated);
    }
}
