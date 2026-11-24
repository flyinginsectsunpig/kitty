using System.Text.Json;
using Kitty.Ledger.Domain.Recurring;

namespace Kitty.Ledger.UnitTests;

/// <summary>Runs contracts/fixtures/recurrence.json — the same file pulse's Go tests run.</summary>
public class RecurrenceFixtureTests
{
    private sealed record BetweenCase(string Name, string Frequency, DateOnly StartsOn, DateOnly From, DateOnly To, DateOnly[] Expected);
    private sealed record IsCase(string Name, string Frequency, DateOnly StartsOn, DateOnly Date, bool Expected);
    private sealed record NextCase(string Name, string Frequency, DateOnly StartsOn, DateOnly Date, DateOnly Expected);
    private sealed record CycleCase(string Name, string Frequency, DateOnly Period, DateOnly Expected);
    private sealed record Fixture(BetweenCase[] Between, IsCase[] IsOccurrence, NextCase[] NextOnOrAfter, CycleCase[] NextCycleStart);

    private static readonly Fixture Data = JsonSerializer.Deserialize<Fixture>(
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "recurrence.json")),
        new JsonSerializerOptions(JsonSerializerDefaults.Web))!;

    private static Frequency F(string s) => Enum.Parse<Frequency>(s, ignoreCase: true);

    public static TheoryData<string> BetweenNames() => new(Data.Between.Select(c => c.Name));
    public static TheoryData<string> IsNames() => new(Data.IsOccurrence.Select(c => c.Name));
    public static TheoryData<string> NextNames() => new(Data.NextOnOrAfter.Select(c => c.Name));
    public static TheoryData<string> CycleNames() => new(Data.NextCycleStart.Select(c => c.Name));

    [Theory, MemberData(nameof(BetweenNames))]
    public void Between_matches(string name)
    {
        var c = Data.Between.Single(x => x.Name == name);
        Assert.Equal(c.Expected, Recurrence.Between(new Rule(F(c.Frequency), c.StartsOn), c.From, c.To));
    }

    [Theory, MemberData(nameof(IsNames))]
    public void IsOccurrence_matches(string name)
    {
        var c = Data.IsOccurrence.Single(x => x.Name == name);
        Assert.Equal(c.Expected, Recurrence.IsOccurrence(new Rule(F(c.Frequency), c.StartsOn), c.Date));
    }

    [Theory, MemberData(nameof(NextNames))]
    public void NextOnOrAfter_matches(string name)
    {
        var c = Data.NextOnOrAfter.Single(x => x.Name == name);
        Assert.Equal(c.Expected, Recurrence.NextOnOrAfter(new Rule(F(c.Frequency), c.StartsOn), c.Date));
    }

    [Theory, MemberData(nameof(CycleNames))]
    public void NextCycleStart_matches(string name)
    {
        var c = Data.NextCycleStart.Single(x => x.Name == name);
        Assert.Equal(c.Expected, Recurrence.NextCycleStart(F(c.Frequency), c.Period));
    }
}
