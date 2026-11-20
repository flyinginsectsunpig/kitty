namespace Kitty.Ledger.Domain.Splits;

/// <summary>A receipt line and who claimed it. No claimers = shared by everyone.</summary>
public sealed record ItemInput(Guid ItemId, long LineTotalMinor, IReadOnlyList<Guid> ClaimerIds);

/// <summary>
/// Spec §5.3: each item splits equally among its claimers (unclaimed items among all participants);
/// additive charges (tip, service, delivery) are shared in proportion to item subtotals, or equally when
/// every subtotal is zero. Every division floors and hands leftover minor units +1 in member order.
/// Returns only participants who owe something, in member order; shares sum to items + charges.
/// </summary>
public static class ItemizedSplitCalculator
{
    private static readonly Comparer<Guid> Order = Comparer<Guid>.Create(MemberOrder.Compare);

    public static SplitResult Calculate(IReadOnlyList<ItemInput> items, long chargesMinor, IReadOnlyList<Guid> participants)
    {
        if (participants.Count == 0) return new SplitResult.Error(SplitErrors.Empty);
        if (participants.Distinct().Count() != participants.Count) return new SplitResult.Error(SplitErrors.DuplicateMember);

        var everyone = participants.Order(Order).ToList();
        var known = everyone.ToHashSet();
        if (chargesMinor is < 0 or > SplitCalculator.MaxTotalMinor
            || items.Any(i => i.LineTotalMinor is < 0 or > SplitCalculator.MaxTotalMinor)
            || items.Any(i => i.ClaimerIds.Any(c => !known.Contains(c))))
            return new SplitResult.Error(SplitErrors.InvalidValue);

        var total = items.Sum(i => i.LineTotalMinor) + chargesMinor;
        if (total is <= 0 or > SplitCalculator.MaxTotalMinor) return new SplitResult.Error(SplitErrors.InvalidValue);

        var subtotals = everyone.ToDictionary(id => id, _ => 0L);
        foreach (var item in items)
        {
            var claimers = item.ClaimerIds.Count == 0 ? everyone : item.ClaimerIds.Distinct().Order(Order).ToList();
            foreach (var (id, minor) in Distribute(item.LineTotalMinor, claimers, _ => 1))
                subtotals[id] += minor;
        }

        var itemsTotal = subtotals.Values.Sum();
        var chargeShares = itemsTotal == 0
            ? Distribute(chargesMinor, everyone, _ => 1)
            : Distribute(chargesMinor, everyone.Where(id => subtotals[id] > 0).ToList(), id => subtotals[id]);
        foreach (var (id, minor) in chargeShares) subtotals[id] += minor;

        return new SplitResult.Ok(everyone.Where(id => subtotals[id] > 0).Select(id => new Share(id, subtotals[id])).ToList());
    }

    /// <summary>Floors amount × weight / Σweight, then +1 per leftover unit in the given (member) order.</summary>
    private static IEnumerable<(Guid Id, long Minor)> Distribute(long amount, IReadOnlyList<Guid> ordered, Func<Guid, long> weight)
    {
        if (amount == 0 || ordered.Count == 0) yield break;
        var weightSum = (Int128)ordered.Sum(weight);
        var shares = ordered.Select(id => (long)((Int128)amount * weight(id) / weightSum)).ToArray();
        var leftover = amount - shares.Sum();
        for (var i = 0; leftover > 0; i = (i + 1) % shares.Length, leftover--) shares[i]++;
        for (var i = 0; i < ordered.Count; i++) yield return (ordered[i], shares[i]);
    }
}
