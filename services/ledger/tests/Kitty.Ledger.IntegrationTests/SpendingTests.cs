using System.Net;
using System.Net.Http.Json;

namespace Kitty.Ledger.IntegrationTests;

public sealed record MoneyDto(string Currency, long Minor, string Text)
{
    /// <summary>MoneyText is pinned by contracts/fixtures/money-format.json, so the tests may use it for expected text.</summary>
    public static MoneyDto Of(long minor, string currency = "ZAR") => new(currency, minor, Domain.MoneyText.Format(minor, currency));
}
public sealed record ExpenseLineDto(Guid ExpenseId, string Description, DateOnly Date, string Category, MoneyDto Total, MoneyDto MyShare,
    string PaidBy);
public sealed record CategoryTotalDto(string Category, MoneyDto Total);
public sealed record PayerTotalDto(Guid MemberId, string Name, MoneyDto Paid);
public sealed record SpendingCurrencyDto(string Currency, MoneyDto Total, MoneyDto MyShare, int Count, List<CategoryTotalDto> ByCategory,
    List<PayerTotalDto> ByPayer, List<ExpenseLineDto> Biggest, List<ExpenseLineDto> Latest);
public sealed record ConvertedSpendingDto(MoneyDto Total, int ExcludedCount);
public sealed record SpendingDto(string GroupCurrency, List<SpendingCurrencyDto> Currencies, ConvertedSpendingDto? Converted);

/// <summary>Expense helpers with a description, a category and a date, for Ask Kitty's lookups.</summary>
public static class SpendingData
{
    public static async Task<Guid> SpendAsync(this HttpClient c, Guid groupId, long amount, Guid payer, IEnumerable<Guid> participants,
        string description, DateOnly on, string category = "food", string currency = "ZAR", string? fxRate = null)
    {
        var r = await c.PostJsonAsync($"/groups/{groupId}/expenses", new
        {
            id = Guid.NewGuid(), description, category, currency, amountMinor = amount, occurredOn = on.ToString("yyyy-MM-dd"),
            payers = new[] { new { memberId = payer, amountMinor = amount } },
            split = new { method = "equal", participants = participants.Select(m => new { memberId = m, value = (long?)null }) },
            fxRate,
        });
        r.EnsureSuccessStatusCode();
        return (await r.ReadAsync<ExpenseDto>()).Id;
    }

    public static Task<HttpResponseMessage> SettleAsync(this HttpClient c, Guid groupId, Guid from, Guid to, long amount,
        string currency = "ZAR") =>
        c.PostJsonAsync($"/groups/{groupId}/settlements", new
        {
            id = Guid.NewGuid(), fromMemberId = from, toMemberId = to, currency, amountMinor = amount, paidInGroupCurrency = false,
        });
}

[Collection(ApiCollection.Name)]
public class SpendingTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private const string Nbsp = " ";

    private async Task<(HttpClient Owner, Guid G, Guid Me, Guid Friend)> FamilyAsync()
    {
        var owner = factory.NewUser("Owner");
        var friend = factory.NewUser("Friend");
        var g = await owner.CreateGroupAsync("Family");
        var joined = await friend.JoinAsync(owner, g.Id);
        Guid M(string n) => joined.Members.Single(m => m.DisplayName == n).Id;
        return (owner, g.Id, M("Owner"), M("Friend"));
    }

    private static async Task<SpendingDto> SpendingAsync(HttpClient c, Guid g, string query = "") =>
        (await c.GetFromJsonAsync<SpendingDto>($"/groups/{g}/spending{query}", Ct))!;

    private static DateOnly D(int month, int day) => new(2026, month, day);

    [Fact]
    public async Task Totals_my_share_and_count_for_a_date_range()
    {
        var (owner, g, me, friend) = await FamilyAsync();
        await owner.SpendAsync(g, 10000, me, [me, friend], "Too early", D(8, 1));
        await owner.SpendAsync(g, 20000, me, [me, friend], "Petrol", D(10, 1));
        await owner.SpendAsync(g, 10000, friend, [me, friend], "Woolies", D(11, 20));

        var s = await SpendingAsync(owner, g, "?from=2026-08-25&to=2026-11-25");

        Assert.Equal("ZAR", s.GroupCurrency);
        var zar = Assert.Single(s.Currencies);
        Assert.Equal(new MoneyDto("ZAR", 30000, $"R{Nbsp}300,00"), zar.Total);
        Assert.Equal(new MoneyDto("ZAR", 15000, $"R{Nbsp}150,00"), zar.MyShare);
        Assert.Equal(2, zar.Count);
        Assert.Null(s.Converted);
    }

    [Fact]
    public async Task Biggest_and_latest_are_five_each_in_order()
    {
        var (owner, g, me, friend) = await FamilyAsync();
        for (var i = 1; i <= 6; i++)
            await owner.SpendAsync(g, i * 1000, me, [me, friend], $"Item {i}", D(11, 7 - i)); // bigger is older

        var zar = Assert.Single((await SpendingAsync(owner, g)).Currencies);

        Assert.Equal(["Item 6", "Item 5", "Item 4", "Item 3", "Item 2"], zar.Biggest.Select(l => l.Description));
        Assert.Equal(["Item 1", "Item 2", "Item 3", "Item 4", "Item 5"], zar.Latest.Select(l => l.Description));
        var top = zar.Biggest[0];
        Assert.Equal((D(11, 1), "food", $"R{Nbsp}60,00", $"R{Nbsp}30,00", "Owner"),
            (top.Date, top.Category, top.Total.Text, top.MyShare.Text, top.PaidBy));
        Assert.Equal(6, zar.Count);
    }

    [Fact]
    public async Task Category_and_text_filters()
    {
        var (owner, g, me, friend) = await FamilyAsync();
        await owner.SpendAsync(g, 2000, me, [me, friend], "Woolies", D(11, 1), category: "groceries");
        await owner.SpendAsync(g, 5000, me, [me, friend], "Uber to airport", D(11, 2), category: "transport");
        await owner.SpendAsync(g, 3000, me, [me, friend], "Dinner", D(11, 3));

        var groceries = Assert.Single((await SpendingAsync(owner, g, "?category=groceries")).Currencies);
        Assert.Equal(["Woolies"], groceries.Latest.Select(l => l.Description));

        var uber = Assert.Single((await SpendingAsync(owner, g, "?q=uber")).Currencies);
        Assert.Equal(["Uber to airport"], uber.Latest.Select(l => l.Description));
        Assert.Equal(5000, uber.Total.Minor);

        Assert.Empty((await SpendingAsync(owner, g, "?q=nothing-like-this")).Currencies);
    }

    [Fact]
    public async Task By_payer_and_by_category_sum()
    {
        var (owner, g, me, friend) = await FamilyAsync();
        await owner.SpendAsync(g, 2000, me, [me, friend], "Woolies", D(11, 1), category: "groceries");
        await owner.SpendAsync(g, 3000, friend, [me, friend], "Spar", D(11, 2), category: "groceries");
        await owner.SpendAsync(g, 1000, friend, [me, friend], "Taxi", D(11, 3), category: "transport");

        var zar = Assert.Single((await SpendingAsync(owner, g)).Currencies);

        Assert.Equal([("groceries", 5000L), ("transport", 1000L)], zar.ByCategory.Select(c => (c.Category, c.Total.Minor)));
        Assert.Equal([(friend, "Friend", 4000L), (me, "Owner", 2000L)], zar.ByPayer.Select(p => (p.MemberId, p.Name, p.Paid.Minor)));
    }

    [Fact]
    public async Task Two_currencies_add_a_converted_total_with_excluded_count()
    {
        var (owner, g, me, friend) = await FamilyAsync();
        await owner.SpendAsync(g, 10000, me, [me, friend], "Braai", D(11, 1));
        await owner.SpendAsync(g, 2000, me, [me, friend], "Paris lunch", D(11, 2), currency: "EUR", fxRate: "19");
        using (factory.Fx.GoDown())
            await owner.SpendAsync(g, 1000, me, [me, friend], "Paris coffee", D(11, 3), currency: "EUR");

        var s = await SpendingAsync(owner, g);

        Assert.Equal(["EUR", "ZAR"], s.Currencies.Select(c => c.Currency));
        Assert.Equal(3000, s.Currencies[0].Total.Minor);
        Assert.NotNull(s.Converted);
        Assert.Equal(new MoneyDto("ZAR", 48000, $"R{Nbsp}480,00"), s.Converted.Total);
        Assert.Equal(1, s.Converted.ExcludedCount);
    }

    [Fact]
    public async Task Settlements_are_not_spending()
    {
        var (owner, g, me, friend) = await FamilyAsync();
        await owner.SpendAsync(g, 10000, me, [me, friend], "Braai", D(11, 1));
        (await owner.SettleAsync(g, friend, me, 5000)).EnsureSuccessStatusCode();

        var zar = Assert.Single((await SpendingAsync(owner, g)).Currencies);

        Assert.Equal((10000L, 1), (zar.Total.Minor, zar.Count));
    }

    [Theory]
    [InlineData("?from=2026-11-25&to=2026-11-01")]
    [InlineData("?category=yachts")]
    public async Task From_after_to_is_400(string query)
    {
        var (owner, g, _, _) = await FamilyAsync();

        var r = await owner.GetAsync($"/groups/{g}/spending{query}", Ct);

        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
    }

    [Fact]
    public async Task Too_long_text_is_400()
    {
        var (owner, g, _, _) = await FamilyAsync();

        var r = await owner.GetAsync($"/groups/{g}/spending?q={new string('a', 101)}", Ct);

        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
    }

    [Fact]
    public async Task Outside_the_group_is_404()
    {
        var (owner, g, me, friend) = await FamilyAsync();
        await owner.SpendAsync(g, 10000, me, [me, friend], "Braai", D(11, 1));
        var stranger = factory.NewUser("Stranger");

        Assert.Equal(HttpStatusCode.NotFound, (await stranger.GetAsync($"/groups/{g}/spending", Ct)).StatusCode);
    }
}
