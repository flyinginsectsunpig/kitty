using System.Text.Json;
using Kitty.Ledger.Domain;

namespace Kitty.Ledger.UnitTests;

/// <summary>Runs contracts/fixtures/money-format.json, written from the apps' formatMoney, so notifications read like the apps.</summary>
public class MoneyTextFixtureTests
{
    private sealed record Case(long Minor, string Currency, string Expected);

    private static readonly Case[] Cases = JsonSerializer.Deserialize<Case[]>(
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "money-format.json")),
        new JsonSerializerOptions(JsonSerializerDefaults.Web))!;

    public static TheoryData<int> Indexes() => new(Enumerable.Range(0, Cases.Length));

    [Theory, MemberData(nameof(Indexes))]
    public void Format_matches_the_apps(int i)
    {
        var c = Cases[i];
        Assert.Equal(c.Expected, MoneyText.Format(c.Minor, c.Currency));
    }
}
