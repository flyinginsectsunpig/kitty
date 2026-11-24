using System.Net;

namespace Kitty.Ledger.IntegrationTests;

public sealed record ExpenseFxDto(Guid Id, string Description, string Currency, long AmountMinor, DateOnly OccurredOn,
    string? FxRate, DateOnly? FxRateDate, string? FxRateSource, long? ConvertedAmountMinor, int Version);

[Collection(ApiCollection.Name)]
public class ExpenseFxTests(LedgerApiFactory factory)
{
    private static readonly DateOnly Sunday = new(2026, 11, 22);
    private static readonly DateOnly Friday = new(2026, 11, 20);

    private async Task<(HttpClient Owner, Guid G, Guid Me, Guid Gran)> GroupAsync()
    {
        var owner = factory.NewUser("Owner");
        var g = await owner.CreateGroupAsync();
        var gran = await owner.AddPlaceholderAsync(g.Id, "Gran");
        return (owner, g.Id, g.Members[0].Id, gran.Id);
    }

    private static object Body(Guid id, long amount, Guid payer, Guid[] participants, string currency, DateOnly on,
        string? fxRate = null, string description = "Dinner", int? version = null) => new
    {
        id, description, category = "food", currency, amountMinor = amount, occurredOn = on.ToString("yyyy-MM-dd"),
        payers = new[] { new { memberId = payer, amountMinor = amount } },
        split = new { method = "equal", participants = participants.Select(m => new { memberId = m, value = (long?)null }) },
        fxRate, version,
    };

    private static async Task<ExpenseFxDto> CreatedAsync(HttpResponseMessage r)
    {
        Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        return await r.ReadAsync<ExpenseFxDto>();
    }

    [Fact]
    public async Task Foreign_expense_gets_the_ecb_rate()
    {
        factory.Fx.Set("EUR", "ZAR", Sunday, 19.1987m, rateDate: Friday);
        var (owner, g, me, gran) = await GroupAsync();

        var e = await CreatedAsync(await owner.PostJsonAsync($"/groups/{g}/expenses", Body(Guid.NewGuid(), 4000, me, [me, gran], "EUR", Sunday)));

        Assert.Equal("19.1987", e.FxRate);
        Assert.Equal(Friday, e.FxRateDate);
        Assert.Equal("ecb", e.FxRateSource);
        Assert.Equal(76795, e.ConvertedAmountMinor);
    }

    [Fact]
    public async Task Typed_rate_is_saved_as_manual()
    {
        var (owner, g, me, gran) = await GroupAsync();

        var e = await CreatedAsync(await owner.PostJsonAsync($"/groups/{g}/expenses",
            Body(Guid.NewGuid(), 4000, me, [me, gran], "EUR", Sunday, fxRate: "19.50")));

        Assert.Equal("19.5", e.FxRate);
        Assert.Null(e.FxRateDate);
        Assert.Equal("manual", e.FxRateSource);
        Assert.Equal(78000, e.ConvertedAmountMinor);
    }

    [Fact]
    public async Task Own_currency_has_no_rate_and_rejects_one()
    {
        var (owner, g, me, gran) = await GroupAsync();

        var e = await CreatedAsync(await owner.PostJsonAsync($"/groups/{g}/expenses", Body(Guid.NewGuid(), 4000, me, [me, gran], "ZAR", Sunday)));
        Assert.Null(e.FxRate);
        Assert.Null(e.FxRateSource);
        Assert.Null(e.ConvertedAmountMinor);

        var r = await owner.PostJsonAsync($"/groups/{g}/expenses", Body(Guid.NewGuid(), 4000, me, [me, gran], "ZAR", Sunday, fxRate: "1"));
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal("fx_rate_invalid", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Pulse_down_saves_without_rate()
    {
        factory.Fx.Set("EUR", "ZAR", Sunday, 19.1987m, rateDate: Friday);
        var (owner, g, me, gran) = await GroupAsync();

        using (factory.Fx.GoDown())
        {
            var e = await CreatedAsync(await owner.PostJsonAsync($"/groups/{g}/expenses", Body(Guid.NewGuid(), 4000, me, [me, gran], "EUR", Sunday)));
            Assert.Null(e.FxRate);
            Assert.Null(e.FxRateDate);
            Assert.Null(e.FxRateSource);
            Assert.Null(e.ConvertedAmountMinor);
        }
    }

    [Fact]
    public async Task Editing_description_keeps_the_saved_rate()
    {
        var on = new DateOnly(2026, 10, 1);
        factory.Fx.Set("EUR", "ZAR", on, 19.1987m);
        var (owner, g, me, gran) = await GroupAsync();
        var id = Guid.NewGuid();
        var e = await CreatedAsync(await owner.PostJsonAsync($"/groups/{g}/expenses", Body(id, 4000, me, [me, gran], "EUR", on)));

        factory.Fx.Set("EUR", "ZAR", on, 25m); // rates moved since (or pulse answers differently)
        var r = await owner.PutJsonAsync($"/groups/{g}/expenses/{id}",
            Body(id, 4000, me, [me, gran], "EUR", on, description: "Dinner at the harbour", version: e.Version));

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var edited = await r.ReadAsync<ExpenseFxDto>();
        Assert.Equal("19.1987", edited.FxRate);
        Assert.Equal(76795, edited.ConvertedAmountMinor);
    }

    [Fact]
    public async Task Changing_the_date_refetches()
    {
        var first = new DateOnly(2026, 10, 2);
        var second = new DateOnly(2026, 10, 5);
        factory.Fx.Set("EUR", "ZAR", first, 19m);
        factory.Fx.Set("EUR", "ZAR", second, 20m);
        var (owner, g, me, gran) = await GroupAsync();
        var id = Guid.NewGuid();
        var e = await CreatedAsync(await owner.PostJsonAsync($"/groups/{g}/expenses", Body(id, 4000, me, [me, gran], "EUR", first)));

        var r = await owner.PutJsonAsync($"/groups/{g}/expenses/{id}", Body(id, 4000, me, [me, gran], "EUR", second, version: e.Version));

        var edited = await r.ReadAsync<ExpenseFxDto>();
        Assert.Equal("20", edited.FxRate);
        Assert.Equal(second, edited.FxRateDate);
    }

    [Fact]
    public async Task Editing_a_rateless_expense_fetches_one()
    {
        var on = new DateOnly(2026, 10, 6);
        var (owner, g, me, gran) = await GroupAsync();
        var id = Guid.NewGuid();
        ExpenseFxDto e;
        using (factory.Fx.GoDown())
            e = await CreatedAsync(await owner.PostJsonAsync($"/groups/{g}/expenses", Body(id, 4000, me, [me, gran], "EUR", on)));
        factory.Fx.Set("EUR", "ZAR", on, 19m);

        var r = await owner.PutJsonAsync($"/groups/{g}/expenses/{id}", Body(id, 4000, me, [me, gran], "EUR", on, version: e.Version));

        Assert.Equal("19", (await r.ReadAsync<ExpenseFxDto>()).FxRate);
    }

    [Fact]
    public async Task Converted_overflow_is_fx_rate_invalid()
    {
        var (owner, g, me, gran) = await GroupAsync();

        var r = await owner.PostJsonAsync($"/groups/{g}/expenses",
            Body(Guid.NewGuid(), 10_000_000_000, me, [me, gran], "EUR", Sunday, fxRate: "1000"));

        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal("fx_rate_invalid", await r.ReadCodeAsync());
    }

    [Theory]
    [InlineData("0")]
    [InlineData("1e3")]
    [InlineData("abc")]
    [InlineData("1.12345678901")]
    public async Task Invalid_rate_string_is_fx_rate_invalid(string rate)
    {
        var (owner, g, me, gran) = await GroupAsync();

        var r = await owner.PostJsonAsync($"/groups/{g}/expenses", Body(Guid.NewGuid(), 4000, me, [me, gran], "EUR", Sunday, fxRate: rate));

        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal("fx_rate_invalid", await r.ReadCodeAsync());
    }
}
