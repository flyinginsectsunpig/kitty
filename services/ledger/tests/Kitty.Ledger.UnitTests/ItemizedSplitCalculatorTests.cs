using System.Text.Json;
using FsCheck;
using FsCheck.Xunit;
using Kitty.Ledger.Domain.Splits;

namespace Kitty.Ledger.UnitTests;

public class ItemizedSplitCalculatorTests
{
    private sealed record FixtureItem(Guid ItemId, long LineTotalMinor, Guid[] ClaimerIds);
    private sealed record FixtureShare(Guid MemberId, long Minor);
    private sealed record Fixture(string Name, long ChargesMinor, Guid[] Participants, FixtureItem[] Items,
        FixtureShare[]? Expected, string? Error);

    public static TheoryData<string> Names() => new(Load().Select(f => f.Name));

    [Theory]
    [MemberData(nameof(Names))]
    public void Shared_fixture_matches(string name)
    {
        var f = Load().Single(x => x.Name == name);
        var result = ItemizedSplitCalculator.Calculate(
            f.Items.Select(i => new ItemInput(i.ItemId, i.LineTotalMinor, i.ClaimerIds)).ToList(), f.ChargesMinor, f.Participants);

        if (f.Error is not null)
            SplitCalculatorTests.AssertError(f.Error, result);
        else
            Assert.Equal(f.Expected!.Select(e => new Share(e.MemberId, e.Minor)), SplitCalculatorTests.Ok(result));
    }

    [Property(MaxTest = 500)]
    public bool Shares_always_sum_to_items_plus_charges(NonEmptyArray<PositiveInt> lines, NonNegativeInt charges, PositiveInt seed)
    {
        var participants = Enumerable.Range(0, 1 + seed.Get % 6).Select(_ => Guid.NewGuid()).ToList();
        var random = new Random(seed.Get);
        var items = lines.Get.Take(20).Select(l => new ItemInput(Guid.NewGuid(), l.Get % 1_000_000,
            participants.Where(_ => random.Next(3) == 0).ToList())).ToList();
        var chargesMinor = (long)(charges.Get % 100_000);
        var expected = items.Sum(i => i.LineTotalMinor) + chargesMinor;

        var result = ItemizedSplitCalculator.Calculate(items, chargesMinor, participants);
        if (expected == 0) return result is SplitResult.Error;
        var shares = SplitCalculatorTests.Ok(result);
        return shares.Sum(s => s.Minor) == expected && shares.All(s => s.Minor > 0);
    }

    private static Fixture[] Load() =>
        JsonSerializer.Deserialize<Fixture[]>(
            File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "fixtures", "itemized.json")),
            new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
}
