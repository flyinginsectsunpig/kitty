using System.Net;
using System.Net.Http.Json;

namespace Kitty.Ledger.IntegrationTests;

public sealed record FxRateDto(string Rate, DateOnly RateDate, string Source);

[Collection(ApiCollection.Name)]
public class FxRateTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private static readonly DateOnly Sunday = new(2026, 11, 22);

    [Fact]
    public async Task Returns_the_rate_for_a_foreign_currency()
    {
        factory.Fx.Set("EUR", "ZAR", Sunday, 19.1987m, rateDate: new DateOnly(2026, 11, 20));
        var owner = factory.NewUser();
        var g = await owner.CreateGroupAsync();

        var r = await owner.GetAsync($"/groups/{g.Id}/fx-rate?currency=EUR&date=2026-11-22", Ct);

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Equal(new FxRateDto("19.1987", new DateOnly(2026, 11, 20), "ecb"), await r.ReadAsync<FxRateDto>());
    }

    [Fact]
    public async Task Pulse_down_is_503_fx_rate_unavailable()
    {
        var owner = factory.NewUser();
        var g = await owner.CreateGroupAsync();
        factory.Fx.Set("EUR", "ZAR", Sunday, 19.1987m);

        using (factory.Fx.GoDown())
        {
            var r = await owner.GetAsync($"/groups/{g.Id}/fx-rate?currency=EUR&date=2026-11-22", Ct);
            Assert.Equal(HttpStatusCode.ServiceUnavailable, r.StatusCode);
            Assert.Equal("fx_rate_unavailable", await r.ReadCodeAsync());
        }
    }

    [Theory]
    [InlineData("ZAR", "validation_failed")]
    [InlineData("XYZ", "currency_unsupported")]
    public async Task Own_or_unknown_currency_is_rejected(string currency, string code)
    {
        var owner = factory.NewUser();
        var g = await owner.CreateGroupAsync();

        var r = await owner.GetAsync($"/groups/{g.Id}/fx-rate?currency={currency}&date=2026-11-22", Ct);

        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal(code, await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Non_member_gets_404()
    {
        var owner = factory.NewUser();
        var g = await owner.CreateGroupAsync();
        factory.Fx.Set("EUR", "ZAR", Sunday, 19.1987m);

        var r = await factory.NewUser("Stranger").GetAsync($"/groups/{g.Id}/fx-rate?currency=EUR&date=2026-11-22", Ct);

        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
    }
}
