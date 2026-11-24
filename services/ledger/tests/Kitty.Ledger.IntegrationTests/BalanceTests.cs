using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Kitty.Ledger.IntegrationTests;

public sealed record MemberNetDto(Guid MemberId, long NetMinor);
public sealed record TransferDto(Guid FromMemberId, Guid ToMemberId, long AmountMinor);
public sealed record CurrencyBalanceDto(string Currency, List<MemberNetDto> Members, List<TransferDto> Transfers);
public sealed record ConvertedBalanceDto(string Currency, List<MemberNetDto> Members, List<TransferDto> Transfers, int ExcludedCount);
public sealed record BalancesDto(List<CurrencyBalanceDto> Currencies, ConvertedBalanceDto? Converted = null);
public sealed record SettlementDto(Guid Id, Guid FromMemberId, Guid ToMemberId, string Currency, long AmountMinor);
public sealed record ActivityDto(Guid Id, DateTimeOffset At, string ActorDisplayName, string EntityType, Guid EntityId,
    string Action, JsonElement? Before, JsonElement? After);

[Collection(ApiCollection.Name)]
public class BalanceTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private async Task<(HttpClient Owner, Guid G, Guid Me, Guid Gran, Guid Sam)> GroupAsync()
    {
        var owner = factory.NewUser("Owner");
        var g = await owner.CreateGroupAsync();
        var gran = await owner.AddPlaceholderAsync(g.Id, "Gran");
        var sam = await owner.AddPlaceholderAsync(g.Id, "Sam");
        return (owner, g.Id, g.Members[0].Id, gran.Id, sam.Id);
    }

    private static async Task<BalancesDto> BalancesAsync(HttpClient c, Guid g) =>
        (await c.GetFromJsonAsync<BalancesDto>($"/groups/{g}/balances", ApiClientExtensions.Json, Ct))!;

    [Fact]
    public async Task Balances_sum_to_zero_per_currency()
    {
        var (owner, g, me, gran, sam) = await GroupAsync();
        await owner.AddEqualAsync(g, 900, me, [me, gran, sam]);
        await owner.AddEqualAsync(g, 1000, gran, [me, gran], currency: "USD");

        var b = await BalancesAsync(owner, g);
        Assert.Equal(["USD", "ZAR"], b.Currencies.Select(c => c.Currency));
        Assert.All(b.Currencies, c => Assert.Equal(0, c.Members.Sum(m => m.NetMinor)));
        Assert.Equal(600, b.Currencies.Single(c => c.Currency == "ZAR").Members.Single(m => m.MemberId == me).NetMinor);
        Assert.Equal(3, b.Currencies[0].Members.Count);
    }

    [Fact]
    public async Task Settlement_of_suggested_transfer_zeroes_balances()
    {
        var (owner, g, me, gran, sam) = await GroupAsync();
        await owner.AddEqualAsync(g, 900, me, [me, gran, sam]);
        await owner.AddEqualAsync(g, 300, gran, [gran, sam]);

        foreach (var t in (await BalancesAsync(owner, g)).Currencies.Single().Transfers)
        {
            var r = await owner.PostJsonAsync($"/groups/{g}/settlements", new
            {
                id = Guid.NewGuid(), fromMemberId = t.FromMemberId, toMemberId = t.ToMemberId, currency = "ZAR", amountMinor = t.AmountMinor,
            });
            Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        }

        var after = (await BalancesAsync(owner, g)).Currencies.Single();
        Assert.All(after.Members, m => Assert.Equal(0, m.NetMinor));
        Assert.Empty(after.Transfers);
    }

    [Fact]
    public async Task Deleted_settlement_restores_the_debt()
    {
        var (owner, g, me, gran, _) = await GroupAsync();
        await owner.AddEqualAsync(g, 1000, me, [me, gran]);
        var s = await (await owner.PostJsonAsync($"/groups/{g}/settlements", new
        {
            id = Guid.NewGuid(), fromMemberId = gran, toMemberId = me, currency = "ZAR", amountMinor = 500,
        })).ReadAsync<SettlementDto>();

        Assert.Equal(HttpStatusCode.NoContent, (await owner.DeleteAsync($"/groups/{g}/settlements/{s.Id}", key: null)).StatusCode);
        Assert.Equal(-500, (await BalancesAsync(owner, g)).Currencies.Single().Members.Single(m => m.MemberId == gran).NetMinor);
    }

    [Theory]
    [InlineData("self")]
    [InlineData("foreign")]
    [InlineData("zero")]
    public async Task Invalid_settlements_are_rejected(string kind)
    {
        var (owner, g, me, gran, _) = await GroupAsync();
        var foreign = (await factory.NewUser().CreateGroupAsync()).Members[0].Id;
        var (to, amount) = kind switch { "self" => (me, 100L), "foreign" => (foreign, 100L), _ => (gran, 0L) };

        var r = await owner.PostJsonAsync($"/groups/{g}/settlements", new
        {
            id = Guid.NewGuid(), fromMemberId = me, toMemberId = to, currency = "ZAR", amountMinor = amount,
        });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal(kind == "foreign" ? "member_not_in_group" : "validation_failed", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Deleted_expense_no_longer_affects_balances()
    {
        var (owner, g, me, gran, _) = await GroupAsync();
        var e = await owner.AddEqualAsync(g, 1000, me, [me, gran]);
        (await owner.DeleteAsync($"/groups/{g}/expenses/{e.Id}", key: null)).EnsureSuccessStatusCode();
        Assert.Empty((await BalancesAsync(owner, g)).Currencies);
    }

    [Fact]
    public async Task Group_list_shows_my_net()
    {
        var (owner, g, me, gran, sam) = await GroupAsync();
        await owner.AddEqualAsync(g, 900, me, [me, gran, sam]);

        var summary = (await owner.GetFromJsonAsync<List<GroupSummaryDto>>("/groups", Ct))!.Single(x => x.Id == g);
        Assert.Equal([new NetDto("ZAR", 600)], summary.MyNet);
    }

    [Fact]
    public async Task Activity_lists_newest_first_with_actor_name()
    {
        var (owner, g, me, gran, _) = await GroupAsync();
        var e = await owner.AddEqualAsync(g, 1000, me, [me, gran]);
        (await owner.DeleteAsync($"/groups/{g}/expenses/{e.Id}", key: null)).EnsureSuccessStatusCode();

        var feed = (await owner.GetFromJsonAsync<List<ActivityDto>>($"/groups/{g}/activity", ApiClientExtensions.Json, Ct))!;
        Assert.Equal("expense:deleted", $"{feed[0].EntityType}:{feed[0].Action}");
        Assert.Equal("expense:created", $"{feed[1].EntityType}:{feed[1].Action}");
        Assert.Equal("Owner", feed[0].ActorDisplayName);
        Assert.True(feed.Zip(feed.Skip(1)).All(p => p.First.At >= p.Second.At));
    }

    [Fact]
    public async Task Balances_include_a_converted_total_for_mixed_currencies()
    {
        factory.Fx.Set("EUR", "ZAR", new DateOnly(2026, 11, 15), 19.1987m);
        var (owner, g, me, gran, _) = await GroupAsync();
        await owner.AddEqualAsync(g, 1000, me, [me, gran]);
        await owner.AddEqualAsync(g, 4000, me, [me, gran], currency: "EUR");

        var converted = (await BalancesAsync(owner, g)).Converted;

        Assert.NotNull(converted);
        Assert.Equal("ZAR", converted.Currency);
        Assert.Equal(0, converted.ExcludedCount);
        Assert.Equal(0, converted.Members.Sum(m => m.NetMinor));
        // Gran owes R5.00 plus her converted half of EUR 40.00 (R383.97 or R383.98, by member order).
        var granNet = converted.Members.Single(m => m.MemberId == gran).NetMinor;
        Assert.InRange(granNet, -(500 + 38398), -(500 + 38397));
        Assert.Equal(new TransferDto(gran, me, -granNet), Assert.Single(converted.Transfers));
    }

    [Fact]
    public async Task Converted_is_null_when_everyone_is_square()
    {
        factory.Fx.Set("EUR", "ZAR", new DateOnly(2026, 11, 15), 19.1987m);
        factory.Fx.Set("EUR", "ZAR", DateOnly.FromDateTime(DateTime.UtcNow), 19.5m);
        var (owner, g, me, gran, _) = await GroupAsync();
        await owner.AddEqualAsync(g, 4000, me, [me, gran], currency: "EUR");
        (await owner.PostJsonAsync($"/groups/{g}/settlements", new
        {
            id = Guid.NewGuid(), fromMemberId = gran, toMemberId = me, currency = "EUR", amountMinor = 2000,
        })).EnsureSuccessStatusCode();

        // Drift leaves a few rand in the converted view, but nobody owes anything in any currency.
        Assert.Null((await BalancesAsync(owner, g)).Converted);
    }

    [Fact]
    public async Task Converted_is_null_when_only_the_group_currency_is_used()
    {
        var (owner, g, me, gran, _) = await GroupAsync();
        await owner.AddEqualAsync(g, 1000, me, [me, gran]);

        Assert.Null((await BalancesAsync(owner, g)).Converted);
    }

}
