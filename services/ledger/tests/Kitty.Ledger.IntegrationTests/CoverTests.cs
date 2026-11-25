using System.Net;

namespace Kitty.Ledger.IntegrationTests;

public sealed record CoverDto(Guid ExpenseId, long AmountMinor);
public sealed record CoveringSettlementDto(Guid Id, long AmountMinor, List<CoverDto> Covers);

[Collection(ApiCollection.Name)]
public class CoverTests(LedgerApiFactory factory)
{
    private static readonly DateOnly On = new(2026, 11, 18);

    /// <summary>Me (the owner) and Joe, in a ZAR group.</summary>
    private async Task<(HttpClient Owner, Guid G, Guid Me, Guid Joe)> FlatAsync()
    {
        var owner = factory.NewUser("Owner");
        var joe = factory.NewUser("Joe");
        var g = await owner.CreateGroupAsync("Flat 4B");
        var joined = await joe.JoinAsync(owner, g.Id);
        Guid M(string n) => joined.Members.Single(m => m.DisplayName == n).Id;
        return (owner, g.Id, M("Owner"), M("Joe"));
    }

    private static async Task AssertCoverInvalidAsync(HttpResponseMessage r)
    {
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal("cover_invalid", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Payment_with_covers_is_saved_and_returned()
    {
        var (c, g, me, joe) = await FlatAsync();
        var uber = await c.SpendAsync(g, 5000, joe, [me, joe], "Uber", On);

        var r = await c.SettleCoveringAsync(g, me, joe, 2500, (uber, 2500));

        Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        Assert.Equal([new CoverDto(uber, 2500)], (await r.ReadAsync<CoveringSettlementDto>()).Covers);
    }

    [Fact]
    public async Task Cover_more_than_open_is_rejected()
    {
        var (c, g, me, joe) = await FlatAsync();
        var uber = await c.SpendAsync(g, 5000, joe, [me, joe], "Uber", On);

        await AssertCoverInvalidAsync(await c.SettleCoveringAsync(g, me, joe, 2600, (uber, 2600)));
    }

    [Fact]
    public async Task Cover_on_an_item_I_dont_owe_is_rejected()
    {
        var (c, g, me, joe) = await FlatAsync();
        var mine = await c.SpendAsync(g, 5000, me, [me, joe], "Uber", On);

        await AssertCoverInvalidAsync(await c.SettleCoveringAsync(g, me, joe, 2500, (mine, 2500)));
    }

    [Fact]
    public async Task Covers_above_the_payment_are_rejected()
    {
        var (c, g, me, joe) = await FlatAsync();
        var uber = await c.SpendAsync(g, 5000, joe, [me, joe], "Uber", On);

        await AssertCoverInvalidAsync(await c.SettleCoveringAsync(g, me, joe, 2000, (uber, 2500)));
    }

    [Fact]
    public async Task Cover_in_another_currency_is_rejected()
    {
        var (c, g, me, joe) = await FlatAsync();
        var dollars = await c.SpendAsync(g, 5000, joe, [me, joe], "Uber", On, currency: "USD", fxRate: "18.50");

        await AssertCoverInvalidAsync(await c.SettleCoveringAsync(g, me, joe, 2500, (dollars, 2500)));
    }

    [Fact]
    public async Task Cover_on_an_item_before_last_square_is_rejected()
    {
        var (c, g, me, joe) = await FlatAsync();
        var uber = await c.SpendAsync(g, 5000, joe, [me, joe], "Uber", On);
        (await c.SettleAsync(g, me, joe, 2500)).EnsureSuccessStatusCode();
        await c.SpendAsync(g, 4000, joe, [me, joe], "Pizza", On.AddDays(1));

        await AssertCoverInvalidAsync(await c.SettleCoveringAsync(g, me, joe, 2000, (uber, 2000)));
    }

    [Fact]
    public async Task A_second_payment_can_cover_the_rest()
    {
        var (c, g, me, joe) = await FlatAsync();
        var uber = await c.SpendAsync(g, 5000, joe, [me, joe], "Uber", On);

        Assert.Equal(HttpStatusCode.Created, (await c.SettleCoveringAsync(g, me, joe, 1000, (uber, 1000))).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await c.SettleCoveringAsync(g, me, joe, 1500, (uber, 1500))).StatusCode);
        await AssertCoverInvalidAsync(await c.SettleCoveringAsync(g, me, joe, 100, (uber, 100)));
    }

    [Fact]
    public async Task Old_payments_without_covers_still_work()
    {
        var (c, g, me, joe) = await FlatAsync();
        await c.SpendAsync(g, 5000, joe, [me, joe], "Uber", On);

        var r = await c.SettleAsync(g, me, joe, 2500);

        Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        Assert.Empty((await r.ReadAsync<CoveringSettlementDto>()).Covers);
    }
}
