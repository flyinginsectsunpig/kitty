using System.Net;
using System.Net.Http.Json;

namespace Kitty.Ledger.IntegrationTests;

public sealed record ExpenseLinePageDto(List<ExpenseLineDto> Items, string? NextCursor);

/// <summary>GET /groups/{id}/expense-lines: the MCP server's expense list, filtered in the database and formatted.</summary>
[Collection(ApiCollection.Name)]
public class ExpenseLineTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private async Task<(HttpClient Owner, Guid G, Guid Me, Guid Sam)> FlatAsync()
    {
        var owner = factory.NewUser("Owner");
        var sam = factory.NewUser("Sam");
        var g = await owner.CreateGroupAsync("Flat");
        var joined = await sam.JoinAsync(owner, g.Id);
        Guid M(string n) => joined.Members.Single(m => m.DisplayName == n).Id;
        return (owner, g.Id, M("Owner"), M("Sam"));
    }

    private static async Task<ExpenseLinePageDto> LinesAsync(HttpClient c, Guid g, string query = "") =>
        (await c.GetFromJsonAsync<ExpenseLinePageDto>($"/groups/{g}/expense-lines{query}", Ct))!;

    private static DateOnly D(int month, int day) => new(2026, month, day);

    [Fact]
    public async Task Lists_newest_first_with_formatted_total_and_my_share()
    {
        var (owner, g, me, sam) = await FlatAsync();
        var dinner = await owner.SpendAsync(g, 45000, me, [me, sam], "Dinner", D(11, 20));
        var groceries = await owner.SpendAsync(g, 8000, me, [me], "Groceries", D(11, 22), "groceries");

        var page = await LinesAsync(owner, g);

        Assert.Equal([groceries, dinner], page.Items.Select(i => i.ExpenseId));
        var line = page.Items[1];
        Assert.Equal(MoneyDto.Of(45000), line.Total);
        Assert.Equal(MoneyDto.Of(22500), line.MyShare);
        Assert.Equal("Owner", line.PaidBy);
        Assert.Null(page.NextCursor);
    }

    [Fact]
    public async Task Filters_by_dates_category_text_and_member()
    {
        var (owner, g, me, sam) = await FlatAsync();
        var early = await owner.SpendAsync(g, 1000, me, [me], "Coffee", D(10, 1), "food");
        var mine = await owner.SpendAsync(g, 2000, me, [me], "Petrol", D(11, 5), "transport");
        var shared = await owner.SpendAsync(g, 3000, sam, [me, sam], "Pizza night", D(11, 10), "food");

        Guid[] Ids(ExpenseLinePageDto p) => p.Items.Select(i => i.ExpenseId).ToArray();
        Assert.Equal([shared, mine], Ids(await LinesAsync(owner, g, "?from=2026-11-01")));
        Assert.Equal([early], Ids(await LinesAsync(owner, g, "?to=2026-10-31")));
        Assert.Equal([mine], Ids(await LinesAsync(owner, g, "?category=transport")));
        Assert.Equal([shared], Ids(await LinesAsync(owner, g, "?q=PIZZA")));
        // Sam paid the pizza and shares nothing else: payer or participant both count.
        Assert.Equal([shared], Ids(await LinesAsync(owner, g, $"?member={sam}")));
    }

    [Fact]
    public async Task Text_filter_is_literal()
    {
        var (owner, g, me, _) = await FlatAsync();
        var off = await owner.SpendAsync(g, 1000, me, [me], "50% off pizza", D(11, 1));
        await owner.SpendAsync(g, 1000, me, [me], "R50 lunch", D(11, 2));
        await owner.SpendAsync(g, 1000, me, [me], "axb", D(11, 3));

        Assert.Equal([off], (await LinesAsync(owner, g, "?q=50%25")).Items.Select(i => i.ExpenseId));
        Assert.Empty((await LinesAsync(owner, g, "?q=a_b")).Items);
    }

    [Fact]
    public async Task Pages_with_the_cursor()
    {
        var (owner, g, me, _) = await FlatAsync();
        var older = await owner.SpendAsync(g, 1000, me, [me], "Older", D(11, 1));
        var newer = await owner.SpendAsync(g, 1000, me, [me], "Newer", D(11, 2));

        var first = await LinesAsync(owner, g, "?limit=1");
        Assert.Equal([newer], first.Items.Select(i => i.ExpenseId));
        Assert.NotNull(first.NextCursor);

        var second = await LinesAsync(owner, g, $"?limit=1&cursor={Uri.EscapeDataString(first.NextCursor!)}");
        Assert.Equal([older], second.Items.Select(i => i.ExpenseId));
        Assert.Null(second.NextCursor);
    }

    [Theory]
    [InlineData("?from=2026-11-02&to=2026-11-01")]
    [InlineData("?category=yachts")]
    [InlineData("?limit=0")]
    [InlineData("?limit=101")]
    [InlineData("?cursor=nonsense")]
    public async Task Rejects_bad_arguments(string query)
    {
        var (owner, g, _, _) = await FlatAsync();
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.GetAsync($"/groups/{g}/expense-lines{query}", Ct)).StatusCode);
    }

    [Fact]
    public async Task Rejects_long_text_and_a_member_from_elsewhere()
    {
        var (owner, g, _, _) = await FlatAsync();
        var q = new string('x', 101);
        Assert.Equal(HttpStatusCode.BadRequest, (await owner.GetAsync($"/groups/{g}/expense-lines?q={q}", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest,
            (await owner.GetAsync($"/groups/{g}/expense-lines?member={Guid.NewGuid()}", Ct)).StatusCode);
    }

    [Fact]
    public async Task Hides_other_groups()
    {
        var (_, g, _, _) = await FlatAsync();
        var stranger = factory.NewUser("Stranger");
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.GetAsync($"/groups/{g}/expense-lines", Ct)).StatusCode);
    }
}
