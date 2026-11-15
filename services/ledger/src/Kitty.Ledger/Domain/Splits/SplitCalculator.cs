namespace Kitty.Ledger.Domain.Splits;

/// <summary>
/// Splits a total into per-member shares. Deterministic: base shares are floored, then each
/// leftover minor unit goes +1 to participants in <see cref="MemberOrder"/>.
/// </summary>
public static class SplitCalculator
{
    public const long MaxTotalMinor = 10_000_000_000;
    public const long FullPercentBasisPoints = 10_000;
    public const long MaxShareWeight = 1_000;

    public static SplitResult Calculate(long totalMinor, SplitMethod method, IReadOnlyList<SplitInput> participants)
    {
        if (participants.Count == 0) return new SplitResult.Error(SplitErrors.Empty);
        if (participants.Select(p => p.MemberId).Distinct().Count() != participants.Count)
            return new SplitResult.Error(SplitErrors.DuplicateMember);
        if (totalMinor <= 0 || totalMinor > MaxTotalMinor) return new SplitResult.Error(SplitErrors.InvalidValue);

        var ordered = participants.OrderBy(p => p.MemberId, Comparer<Guid>.Create(MemberOrder.Compare)).ToList();

        return method switch
        {
            SplitMethod.Equal => Distribute(totalMinor, ordered, _ => totalMinor / ordered.Count),
            SplitMethod.Exact => Exact(totalMinor, ordered),
            SplitMethod.Percent => Weighted(totalMinor, ordered, FullPercentBasisPoints, mustSumTo: FullPercentBasisPoints),
            SplitMethod.Shares => Weighted(totalMinor, ordered, MaxShareWeight, mustSumTo: null),
            _ => throw new ArgumentOutOfRangeException(nameof(method), method, null),
        };
    }

    private static SplitResult Exact(long totalMinor, List<SplitInput> ordered)
    {
        if (ordered.Any(p => p.Value is null or <= 0)) return new SplitResult.Error(SplitErrors.InvalidValue);
        if (ordered.Sum(p => p.Value!.Value) != totalMinor) return new SplitResult.Error(SplitErrors.SumMismatch);
        return new SplitResult.Ok(ordered.Select(p => new Share(p.MemberId, p.Value!.Value)).ToList());
    }

    private static SplitResult Weighted(long totalMinor, List<SplitInput> ordered, long maxValue, long? mustSumTo)
    {
        if (ordered.Any(p => p.Value is null or <= 0 || p.Value > maxValue))
            return new SplitResult.Error(SplitErrors.InvalidValue);

        var weightSum = ordered.Sum(p => p.Value!.Value);
        if (mustSumTo is not null && weightSum != mustSumTo) return new SplitResult.Error(SplitErrors.SumMismatch);

        // total ≤ 1e10 and weight ≤ 1e4, so the product fits comfortably in a long.
        return Distribute(totalMinor, ordered, p => checked(totalMinor * p.Value!.Value) / weightSum);
    }

    private static SplitResult.Ok Distribute(long totalMinor, List<SplitInput> ordered, Func<SplitInput, long> baseShare)
    {
        var amounts = ordered.Select(baseShare).ToArray();
        var leftover = totalMinor - amounts.Sum();
        for (var i = 0; leftover > 0; i = (i + 1) % amounts.Length, leftover--)
            amounts[i] += 1;

        return new SplitResult.Ok(ordered.Select((p, i) => new Share(p.MemberId, amounts[i])).ToList());
    }
}
