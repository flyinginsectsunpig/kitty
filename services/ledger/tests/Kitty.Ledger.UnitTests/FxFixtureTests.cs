using System.Text.Json;
using Kitty.Ledger.Domain.Fx;
using Kitty.Ledger.Domain.Splits;

namespace Kitty.Ledger.UnitTests;

/// <summary>Runs contracts/fixtures/fx.json — the same file the TypeScript parseRate/convertMinor tests run.</summary>
public class FxFixtureTests
{
    private sealed record RateCase(string Input, string? Canonical);
    private sealed record Conversion(string Name, long Minor, string Rate, string From, string To, long Expected);
    private sealed record Part(Guid MemberId, long Minor);
    private sealed record SpreadCase(string Name, string Rate, string From, string To, Part[] Parts, Part[] Expected);
    private sealed record Fixture(RateCase[] Rates, Conversion[] Conversions, SpreadCase[] Spreads);

    private static readonly Fixture Data = JsonSerializer.Deserialize<Fixture>(
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "fx.json")),
        new JsonSerializerOptions(JsonSerializerDefaults.Web))!;

    public static TheoryData<string> RateInputs() => new(Data.Rates.Select(r => r.Input));
    public static TheoryData<string> ConversionNames() => new(Data.Conversions.Select(c => c.Name));
    public static TheoryData<string> SpreadNames() => new(Data.Spreads.Select(s => s.Name));

    [Theory]
    [MemberData(nameof(RateInputs))]
    public void Rate_parses_to_its_canonical_form(string input)
    {
        var expected = Data.Rates.Single(r => r.Input == input).Canonical;
        var ok = FxRate.TryParse(input, out var rate);
        Assert.Equal(expected is not null, ok);
        if (ok) Assert.Equal(expected, FxRate.Format(rate));
    }

    [Theory]
    [MemberData(nameof(ConversionNames))]
    public void Conversion_matches(string name)
    {
        var c = Data.Conversions.Single(x => x.Name == name);
        Assert.True(FxRate.TryParse(c.Rate, out var rate));
        Assert.Equal(c.Expected, FxConverter.Convert(c.Minor, rate, c.From, c.To));
    }

    [Theory]
    [MemberData(nameof(SpreadNames))]
    public void Spread_matches(string name)
    {
        var s = Data.Spreads.Single(x => x.Name == name);
        Assert.True(FxRate.TryParse(s.Rate, out var rate));
        var result = FxConverter.Spread(s.Parts.Select(p => new Share(p.MemberId, p.Minor)).ToList(), rate, s.From, s.To);
        Assert.Equal(s.Expected.Select(p => new Share(p.MemberId, p.Minor)), result);
    }
}
