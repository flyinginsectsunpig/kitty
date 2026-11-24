using System.Net;
using System.Net.Http.Json;

namespace Kitty.Ledger.IntegrationTests;

public sealed record SettlementFxDto(Guid Id, string Currency, long AmountMinor, string? FxRate, DateOnly? FxRateDate,
    string? FxRateSource, long? ConvertedAmountMinor, bool PaidInGroupCurrency);

[Collection(ApiCollection.Name)]
public class SettlementFxTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    // Settlements take the rate of the day they're recorded (UTC).
    private static DateOnly Today => DateOnly.FromDateTime(DateTime.UtcNow);

    private async Task<(HttpClient Owner, Guid G, Guid Me, Guid Gran)> GroupAsync()
    {
        var owner = factory.NewUser("Owner");
        var g = await owner.CreateGroupAsync();
        var gran = await owner.AddPlaceholderAsync(g.Id, "Gran");
        return (owner, g.Id, g.Members[0].Id, gran.Id);
    }

    private static Task<HttpResponseMessage> SettleAsync(HttpClient c, Guid g, Guid from, Guid to, string currency, long amount,
        string? fxRate = null, bool paidInGroupCurrency = false) =>
        c.PostJsonAsync($"/groups/{g}/settlements", new
        {
            id = Guid.NewGuid(), fromMemberId = from, toMemberId = to, currency, amountMinor = amount, fxRate, paidInGroupCurrency,
        });

    private static async Task<SettlementFxDto> CreatedAsync(HttpResponseMessage r)
    {
        Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        return await r.ReadAsync<SettlementFxDto>();
    }

    [Fact]
    public async Task Foreign_settlement_gets_todays_rate()
    {
        factory.Fx.Set("EUR", "ZAR", Today, 19.1987m);
        var (owner, g, me, gran) = await GroupAsync();

        var s = await CreatedAsync(await SettleAsync(owner, g, gran, me, "EUR", 2000));

        Assert.Equal("19.1987", s.FxRate);
        Assert.Equal(Today, s.FxRateDate);
        Assert.Equal("ecb", s.FxRateSource);
        Assert.Equal(38397, s.ConvertedAmountMinor);
        Assert.False(s.PaidInGroupCurrency);
    }

    [Fact]
    public async Task Pay_in_group_currency_stores_the_paid_amount()
    {
        var (owner, g, me, gran) = await GroupAsync();

        var s = await CreatedAsync(await SettleAsync(owner, g, gran, me, "EUR", 2000, fxRate: "19.5", paidInGroupCurrency: true));

        Assert.Equal(39000, s.ConvertedAmountMinor);
        Assert.True(s.PaidInGroupCurrency);
        Assert.Equal("manual", s.FxRateSource);
        Assert.Equal("EUR", s.Currency);
        Assert.Equal(2000, s.AmountMinor);
    }

    [Fact]
    public async Task Paying_at_the_ecb_rate_the_page_showed_keeps_it_as_ecb()
    {
        var friday = Today.AddDays(-3);
        factory.Fx.Set("EUR", "ZAR", Today, 19.1987m, rateDate: friday);
        var (owner, g, me, gran) = await GroupAsync();

        // The settle page shows today's ECB rate and the rand amount; paying in rand sends that rate back.
        var s = await CreatedAsync(await SettleAsync(owner, g, gran, me, "EUR", 2000, fxRate: "19.1987", paidInGroupCurrency: true));

        Assert.Equal("19.1987", s.FxRate);
        Assert.Equal("ecb", s.FxRateSource);
        Assert.Equal(friday, s.FxRateDate);
        Assert.Equal(38397, s.ConvertedAmountMinor);
    }

    [Fact]
    public async Task The_amount_shown_is_the_amount_stored_even_if_the_rate_moved_since()
    {
        factory.Fx.Set("EUR", "ZAR", Today, 19.9m); // the ECB published after the page loaded
        var (owner, g, me, gran) = await GroupAsync();

        var s = await CreatedAsync(await SettleAsync(owner, g, gran, me, "EUR", 2000, fxRate: "19.1987", paidInGroupCurrency: true));

        Assert.Equal("19.1987", s.FxRate);
        Assert.Equal(38397, s.ConvertedAmountMinor);
        Assert.Equal("manual", s.FxRateSource);
    }

    [Fact]
    public async Task Pulse_down_without_rate_is_422()
    {
        var (owner, g, me, gran) = await GroupAsync();

        using (factory.Fx.GoDown())
        {
            var r = await SettleAsync(owner, g, gran, me, "EUR", 2000);
            Assert.Equal(HttpStatusCode.UnprocessableEntity, r.StatusCode);
            Assert.Equal("fx_rate_required", await r.ReadCodeAsync());
        }
    }

    [Fact]
    public async Task Pulse_down_with_typed_rate_succeeds()
    {
        var (owner, g, me, gran) = await GroupAsync();

        using (factory.Fx.GoDown())
        {
            var s = await CreatedAsync(await SettleAsync(owner, g, gran, me, "EUR", 2000, fxRate: "19.5"));
            Assert.Equal("19.5", s.FxRate);
        }
    }

    [Fact]
    public async Task Pay_in_group_currency_needs_a_foreign_currency()
    {
        var (owner, g, me, gran) = await GroupAsync();

        var r = await SettleAsync(owner, g, gran, me, "ZAR", 2000, paidInGroupCurrency: true);

        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal("validation_failed", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Own_currency_settlement_has_no_rate()
    {
        var (owner, g, me, gran) = await GroupAsync();

        var s = await CreatedAsync(await SettleAsync(owner, g, gran, me, "ZAR", 2000));

        Assert.Null(s.FxRate);
        Assert.Null(s.ConvertedAmountMinor);
    }

    [Fact]
    public async Task Settlement_still_reduces_the_debts_currency()
    {
        factory.Fx.Set("EUR", "ZAR", new DateOnly(2026, 11, 15), 19.1987m);
        var (owner, g, me, gran) = await GroupAsync();
        await owner.AddEqualAsync(g, 4000, me, [me, gran], currency: "EUR"); // Gran owes me EUR 20.00

        await CreatedAsync(await SettleAsync(owner, g, gran, me, "EUR", 2000, fxRate: "19.5", paidInGroupCurrency: true));

        var balances = (await owner.GetFromJsonAsync<BalancesDto>($"/groups/{g}/balances", ApiClientExtensions.Json, Ct))!;
        Assert.All(balances.Currencies.Single(c => c.Currency == "EUR").Members, m => Assert.Equal(0, m.NetMinor));
    }
}
