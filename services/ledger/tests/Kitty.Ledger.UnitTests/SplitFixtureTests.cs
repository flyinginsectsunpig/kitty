using System.Text.Json;
using Kitty.Ledger.Domain.Splits;

namespace Kitty.Ledger.UnitTests;

/// <summary>Runs contracts/fixtures/splits.json — the same file the TypeScript previewSplit tests run.</summary>
public class SplitFixtureTests
{
    private sealed record FixtureParticipant(Guid MemberId, long? Value);
    private sealed record FixtureShare(Guid MemberId, long Minor);
    private sealed record Fixture(string Name, long TotalMinor, string Method, FixtureParticipant[] Participants,
        FixtureShare[]? Expected, string? Error);

    public static TheoryData<string> Names() => new(Load().Select(f => f.Name));

    [Theory]
    [MemberData(nameof(Names))]
    public void Shared_fixture_matches(string name)
    {
        var f = Load().Single(x => x.Name == name);
        var method = Enum.Parse<SplitMethod>(f.Method, ignoreCase: true);
        var result = SplitCalculator.Calculate(f.TotalMinor, method,
            f.Participants.Select(p => new SplitInput(p.MemberId, p.Value)).ToList());

        if (f.Error is not null)
            SplitCalculatorTests.AssertError(f.Error, result);
        else
            Assert.Equal(f.Expected!.Select(e => new Share(e.MemberId, e.Minor)), SplitCalculatorTests.Ok(result));
    }

    private static Fixture[] Load() =>
        JsonSerializer.Deserialize<Fixture[]>(
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "splits.json")),
            new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
}
