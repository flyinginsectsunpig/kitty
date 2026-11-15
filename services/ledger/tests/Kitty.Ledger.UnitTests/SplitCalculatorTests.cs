using FsCheck;
using FsCheck.Xunit;
using Kitty.Ledger.Domain.Splits;

namespace Kitty.Ledger.UnitTests;

public class SplitCalculatorTests
{
    internal static readonly Guid A = Guid.Parse("00000001-0000-0000-0000-000000000000"),
                                  B = Guid.Parse("00000002-0000-0000-0000-000000000000"),
                                  C = Guid.Parse("00000003-0000-0000-0000-000000000000");

    [Fact]
    public void Equal_three_way_gives_remainder_in_member_order()
    {
        var r = Ok(SplitCalculator.Calculate(10000, SplitMethod.Equal, [new(C, null), new(A, null), new(B, null)]));
        Assert.Equal([new Share(A, 3334), new Share(B, 3333), new Share(C, 3333)], r);
    }

    [Fact]
    public void Exact_must_sum_to_total() =>
        AssertError("split_sum_mismatch", SplitCalculator.Calculate(1000, SplitMethod.Exact, [new(A, 400), new(B, 500)]));

    [Fact]
    public void Percent_must_sum_to_10000_bp() =>
        AssertError("split_sum_mismatch", SplitCalculator.Calculate(1000, SplitMethod.Percent, [new(A, 5000), new(B, 4000)]));

    [Fact]
    public void Percent_floors_then_distributes_remainder()
    {
        var r = Ok(SplitCalculator.Calculate(1001, SplitMethod.Percent, [new(A, 3334), new(B, 3333), new(C, 3333)]));
        Assert.Equal(1001, r.Sum(s => s.Minor));
    }

    [Fact]
    public void Shares_weight_2_1() =>
        Assert.Equal([new Share(A, 667), new Share(B, 333)],
            Ok(SplitCalculator.Calculate(1000, SplitMethod.Shares, [new(A, 2), new(B, 1)])));

    [Fact]
    public void Zero_or_negative_values_rejected() =>
        AssertError("split_invalid_value", SplitCalculator.Calculate(1000, SplitMethod.Shares, [new(A, 0), new(B, 1)]));

    [Fact]
    public void Duplicate_member_rejected() =>
        AssertError("split_duplicate_member", SplitCalculator.Calculate(1000, SplitMethod.Equal, [new(A, null), new(A, null)]));

    [Fact]
    public void Exact_values_that_would_overflow_are_rejected_not_a_crash() =>
        AssertError("split_invalid_value",
            SplitCalculator.Calculate(1000, SplitMethod.Exact, [new(A, long.MaxValue), new(B, long.MaxValue)]));

    [Fact]
    public void Empty_participants_rejected() =>
        AssertError("split_empty", SplitCalculator.Calculate(1000, SplitMethod.Equal, []));

    [Property(MaxTest = 500)]
    public bool Shares_always_sum_to_total(PositiveInt total, NonEmptyArray<PositiveInt> weights)
    {
        var totalMinor = Math.Min(total.Get, 1_000_000_000L);
        var participants = weights.Get.Take(50)
            .Select(w => new SplitInput(Guid.NewGuid(), Math.Clamp(w.Get, 1, 1000)))
            .ToList();
        var shares = Ok(SplitCalculator.Calculate(totalMinor, SplitMethod.Shares, participants));
        return shares.Sum(s => s.Minor) == totalMinor && shares.All(s => s.Minor >= 0);
    }

    [Property(MaxTest = 500)]
    public bool Equal_shares_differ_by_at_most_one(PositiveInt total, PositiveInt count)
    {
        var n = Math.Clamp(count.Get, 1, 50);
        var participants = Enumerable.Range(0, n).Select(_ => new SplitInput(Guid.NewGuid(), null)).ToList();
        var shares = Ok(SplitCalculator.Calculate(total.Get, SplitMethod.Equal, participants));
        return shares.Sum(s => s.Minor) == total.Get && shares.Max(s => s.Minor) - shares.Min(s => s.Minor) <= 1;
    }

    internal static IReadOnlyList<Share> Ok(SplitResult result) =>
        result is SplitResult.Ok ok ? ok.Shares : throw new Xunit.Sdk.XunitException($"Expected Ok, got {result}");

    internal static void AssertError(string code, SplitResult result) =>
        Assert.Equal(code, Assert.IsType<SplitResult.Error>(result).Code);
}
