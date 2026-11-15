namespace Kitty.Ledger.Domain.Balances;

public sealed record Transfer(Guid From, Guid To, long Minor);

public static class DebtSimplifier
{
    /// <summary>
    /// Turns one currency's net positions into at most n−1 transfers: repeatedly the largest debtor
    /// pays the largest creditor min(debt, credit). Ties are broken by <see cref="MemberOrder"/>,
    /// so the same balances always produce the same suggestions.
    /// </summary>
    public static IReadOnlyList<Transfer> Simplify(IReadOnlyDictionary<Guid, long> nets)
    {
        if (nets.Values.Sum() != 0)
            throw new ArgumentException("Net positions must sum to zero.", nameof(nets));

        var remaining = nets.Where(kv => kv.Value != 0).ToDictionary(kv => kv.Key, kv => kv.Value);
        var transfers = new List<Transfer>();

        while (remaining.Count > 0)
        {
            var creditor = Largest(remaining.Where(kv => kv.Value > 0), kv => kv.Value);
            var debtor = Largest(remaining.Where(kv => kv.Value < 0), kv => -kv.Value);
            var amount = Math.Min(creditor.Value, -debtor.Value);

            transfers.Add(new Transfer(debtor.Key, creditor.Key, amount));
            Settle(remaining, creditor.Key, -amount);
            Settle(remaining, debtor.Key, amount);
        }

        return transfers;
    }

    private static KeyValuePair<Guid, long> Largest(IEnumerable<KeyValuePair<Guid, long>> candidates,
        Func<KeyValuePair<Guid, long>, long> magnitude) =>
        candidates
            .OrderByDescending(magnitude)
            .ThenBy(kv => kv.Key, Comparer<Guid>.Create(MemberOrder.Compare))
            .First();

    private static void Settle(Dictionary<Guid, long> remaining, Guid member, long delta)
    {
        var value = remaining[member] + delta;
        if (value == 0) remaining.Remove(member);
        else remaining[member] = value;
    }
}
