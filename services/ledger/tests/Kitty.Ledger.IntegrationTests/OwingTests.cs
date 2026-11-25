using System.Net.Http.Json;

namespace Kitty.Ledger.IntegrationTests;

public sealed record OwingTransferDto(string Direction, Guid MemberId, string Name, MoneyDto Amount);
public sealed record OwingPaymentDto(string From, string To, MoneyDto Amount, DateOnly Date);
public sealed record OwingCurrencyDto(string Currency, MoneyDto MyNet, List<OwingTransferDto> Transfers, List<ExpenseLineDto> Since,
    int MoreSince, List<OwingPaymentDto> Payments);
public sealed record OwingGroupDto(Guid Id, string Name, List<OwingCurrencyDto> Currencies);
public sealed record OwingPersonDto(Guid? UserId, Guid? MemberId, string Name, List<MoneyDto> IOwe, List<MoneyDto> OwesMe,
    List<string> Groups);
public sealed record OwingDto(List<MoneyDto> IOwe, List<MoneyDto> OwedToMe, List<OwingPersonDto> People, List<OwingGroupDto> Groups);

[Collection(ApiCollection.Name)]
public class OwingTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private static readonly DateOnly On = new(2026, 11, 18);

    /// <summary>"Flat 4B" (owner, friend, third) and "Family" (owner, friend). Nobody owes anything yet.</summary>
    private sealed record Env(HttpClient Owner, HttpClient Friend, HttpClient Third, Guid Flat, Guid Family,
        Guid Me, Guid FriendM, Guid ThirdM, Guid MeInFamily, Guid FriendInFamily, Guid FriendU);

    private async Task<Env> WorldAsync()
    {
        var owner = factory.NewUser("Owner");
        var friend = factory.NewUser("Friend");
        var third = factory.NewUser("Third");
        var flat = await owner.CreateGroupAsync("Flat 4B");
        await friend.JoinAsync(owner, flat.Id);
        var joined = await third.JoinAsync(owner, flat.Id);
        var family = await owner.CreateGroupAsync("Family");
        var inFamily = await friend.JoinAsync(owner, family.Id);
        Guid M(GroupDto g, string n) => g.Members.Single(m => m.DisplayName == n).Id;
        return new Env(owner, friend, third, flat.Id, family.Id, M(joined, "Owner"), M(joined, "Friend"), M(joined, "Third"),
            M(inFamily, "Owner"), M(inFamily, "Friend"), (await friend.MeAsync()).Id);
    }

    private static async Task<OwingDto> OwingAsync(HttpClient c) => (await c.GetFromJsonAsync<OwingDto>("/me/owing", Ct))!;

    private static DateOnly SouthAfricanToday => DateOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(2)).DateTime);

    [Fact]
    public async Task Grand_totals_across_groups_are_not_netted()
    {
        var w = await WorldAsync();
        await w.Owner.SpendAsync(w.Flat, 20000, w.FriendM, [w.Me, w.FriendM], "Groceries", On);           // I owe R 100,00
        await w.Owner.SpendAsync(w.Family, 6000, w.MeInFamily, [w.MeInFamily, w.FriendInFamily], "Woolies", On); // owed R 30,00

        var o = await OwingAsync(w.Owner);

        Assert.Equal([MoneyDto.Of(10000)], o.IOwe);
        Assert.Equal([MoneyDto.Of(3000)], o.OwedToMe);
        Assert.Equal(["Family", "Flat 4B"], o.Groups.Select(g => g.Name));
        var flat = Assert.Single(o.Groups.Single(g => g.Id == w.Flat).Currencies);
        Assert.Equal(("ZAR", -10000L), (flat.Currency, flat.MyNet.Minor));
    }

    [Fact]
    public async Task Per_person_follows_the_settle_up_plan()
    {
        var w = await WorldAsync();
        await w.Owner.SpendAsync(w.Flat, 3000, w.FriendM, [w.ThirdM], "Lift", On); // third owes friend R 30,00
        await w.Owner.SpendAsync(w.Flat, 3000, w.ThirdM, [w.Me], "Pizza", On);    // I owe third R 30,00

        var o = await OwingAsync(w.Owner);

        var zar = Assert.Single(Assert.Single(o.Groups).Currencies);
        var t = Assert.Single(zar.Transfers);
        Assert.Equal(("i_pay", w.FriendM, "Friend", 3000L), (t.Direction, t.MemberId, t.Name, t.Amount.Minor));
        var friend = Assert.Single(o.People);
        Assert.Equal((w.FriendU, (Guid?)null, "Friend"), (friend.UserId, friend.MemberId, friend.Name));
        Assert.Equal([MoneyDto.Of(3000)], friend.IOwe);
        Assert.Empty(friend.OwesMe);
        Assert.Equal(["Flat 4B"], friend.Groups);
    }

    [Fact]
    public async Task Since_lists_items_after_I_was_last_square()
    {
        var w = await WorldAsync();
        await w.Owner.SpendAsync(w.Flat, 2000, w.FriendM, [w.Me, w.FriendM], "Old", On);
        (await w.Owner.SettleAsync(w.Flat, w.Me, w.FriendM, 1000)).EnsureSuccessStatusCode();
        await w.Owner.SpendAsync(w.Flat, 5000, w.FriendM, [w.Me, w.FriendM], "Uber", On);
        await w.Owner.SpendAsync(w.Flat, 19000, w.FriendM, [w.Me, w.FriendM], "Groceries", On.AddDays(2));

        var zar = Assert.Single(Assert.Single((await OwingAsync(w.Owner)).Groups).Currencies);

        Assert.Equal(["Groceries", "Uber"], zar.Since.Select(l => l.Description));
        var uber = zar.Since[1];
        Assert.Equal((On, "R 50,00", "R 25,00", "Friend"), (uber.Date, uber.Total.Text, uber.MyShare.Text, uber.PaidBy));
        Assert.Empty(zar.Payments);
        Assert.Equal(0, zar.MoreSince);
        Assert.Equal(MoneyDto.Of(-12000), zar.MyNet);
    }

    [Fact]
    public async Task Part_payment_lists_items_and_the_payment()
    {
        var w = await WorldAsync();
        await w.Owner.SpendAsync(w.Flat, 5000, w.FriendM, [w.Me, w.FriendM], "Uber", On);
        await w.Owner.SpendAsync(w.Flat, 19000, w.FriendM, [w.Me, w.FriendM], "Groceries", On.AddDays(2));
        (await w.Owner.SettleAsync(w.Flat, w.Me, w.FriendM, 5000)).EnsureSuccessStatusCode();

        var zar = Assert.Single(Assert.Single((await OwingAsync(w.Owner)).Groups).Currencies);

        Assert.Equal(["Groceries", "Uber"], zar.Since.Select(l => l.Description));
        Assert.Equal([new OwingPaymentDto("Owner", "Friend", MoneyDto.Of(5000), SouthAfricanToday)], zar.Payments);
        Assert.Equal(MoneyDto.Of(-7000), zar.MyNet);
        Assert.Equal(7000, Assert.Single(zar.Transfers).Amount.Minor);
    }

    [Fact]
    public async Task Deleted_expense_is_not_listed()
    {
        var w = await WorldAsync();
        await w.Owner.SpendAsync(w.Flat, 4000, w.FriendM, [w.Me, w.FriendM], "Kept", On);
        var gone = await w.Owner.SpendAsync(w.Flat, 2000, w.FriendM, [w.Me, w.FriendM], "Gone", On);
        (await w.Owner.DeleteAsync($"/groups/{w.Flat}/expenses/{gone}", key: null)).EnsureSuccessStatusCode();

        var zar = Assert.Single(Assert.Single((await OwingAsync(w.Owner)).Groups).Currencies);

        Assert.Equal(["Kept"], zar.Since.Select(l => l.Description));
        Assert.Equal(-2000, zar.MyNet.Minor);
    }

    [Fact]
    public async Task People_merge_by_account_not_by_name()
    {
        var w = await WorldAsync();
        (await w.Friend.PatchJsonAsync($"/groups/{w.Family}/members/{w.FriendInFamily}", new { displayName = "Frankie" }))
            .EnsureSuccessStatusCode();
        var club = await w.Owner.CreateGroupAsync("Book club");
        var me = Assert.Single(club.Members).Id;
        var placeholder = await w.Owner.AddPlaceholderAsync(club.Id, "Friend");
        await w.Owner.SpendAsync(w.Flat, 2000, w.FriendM, [w.Me, w.FriendM], "Uber", On);
        await w.Owner.SpendAsync(w.Family, 4000, w.FriendInFamily, [w.MeInFamily, w.FriendInFamily], "Woolies", On);
        await w.Owner.SpendAsync(club.Id, 3000, me, [me, placeholder.Id], "Books", On);

        var o = await OwingAsync(w.Owner);

        Assert.Equal(2, o.People.Count);
        var account = o.People.Single(p => p.UserId == w.FriendU);
        Assert.Equal(("Friend", (Guid?)null), (account.Name, account.MemberId));
        Assert.Equal([MoneyDto.Of(3000)], account.IOwe);
        Assert.Equal(["Family", "Flat 4B"], account.Groups);
        var ph = o.People.Single(p => p.UserId is null);
        Assert.Equal((placeholder.Id, "Friend"), (ph.MemberId, ph.Name));
        Assert.Equal([MoneyDto.Of(1500)], ph.OwesMe);
        Assert.Equal(["Book club"], ph.Groups);
        Assert.Equal("Frankie", Assert.Single(Assert.Single(o.Groups.Single(g => g.Id == w.Family).Currencies).Transfers).Name);
    }

    [Fact]
    public async Task Square_everywhere_is_empty()
    {
        var w = await WorldAsync();
        await w.Owner.SpendAsync(w.Flat, 2000, w.FriendM, [w.Me, w.FriendM], "Uber", On);
        (await w.Owner.SettleAsync(w.Flat, w.Me, w.FriendM, 1000)).EnsureSuccessStatusCode();

        var o = await OwingAsync(w.Owner);

        Assert.Equal((0, 0, 0, 0), (o.IOwe.Count, o.OwedToMe.Count, o.People.Count, o.Groups.Count));
    }

    [Fact]
    public async Task More_than_ten_items_reports_more_since()
    {
        var w = await WorldAsync();
        for (var i = 1; i <= 12; i++)
            await w.Owner.SpendAsync(w.Flat, 200, w.FriendM, [w.Me, w.FriendM], $"Item {i}", On);

        var zar = Assert.Single(Assert.Single((await OwingAsync(w.Owner)).Groups).Currencies);

        Assert.Equal(10, zar.Since.Count);
        Assert.Equal(2, zar.MoreSince);
        Assert.Equal("Item 12", zar.Since[0].Description);
    }

    [Fact]
    public async Task Two_currencies_are_listed_separately()
    {
        var w = await WorldAsync();
        await w.Owner.SpendAsync(w.Flat, 2000, w.FriendM, [w.Me, w.FriendM], "Braai", On);
        await w.Owner.SpendAsync(w.Flat, 2000, w.FriendM, [w.Me, w.FriendM], "Paris lunch", On, currency: "EUR", fxRate: "19");

        var o = await OwingAsync(w.Owner);

        Assert.Equal([MoneyDto.Of(1000, "EUR"), MoneyDto.Of(1000)], o.IOwe);
        Assert.Equal(["EUR", "ZAR"], Assert.Single(o.Groups).Currencies.Select(c => c.Currency));
        Assert.Equal(["Paris lunch"], Assert.Single(o.Groups).Currencies[0].Since.Select(l => l.Description));
    }
}
