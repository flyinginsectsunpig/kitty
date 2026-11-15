using Kitty.Ledger.Domain.Splits;

namespace Kitty.Ledger.Domain.Balances;

/// <summary>An expense reduced to what balances need: who paid and who owes, in one currency.</summary>
public sealed record LedgerExpense(string Currency, IReadOnlyList<Share> Payers, IReadOnlyList<Share> Shares);

/// <summary><paramref name="From"/> paid <paramref name="To"/> back <paramref name="Minor"/> units.</summary>
public sealed record LedgerSettlement(string Currency, Guid From, Guid To, long Minor);

public static class BalanceCalculator
{
    /// <summary>
    /// Net position per member per currency. Positive = the member is owed money.
    /// Currencies are never mixed; each currency's nets sum to zero.
    /// </summary>
    public static IReadOnlyDictionary<string, IReadOnlyDictionary<Guid, long>> NetByCurrency(
        IEnumerable<LedgerExpense> expenses, IEnumerable<LedgerSettlement> settlements)
    {
        var nets = new Dictionary<string, Dictionary<Guid, long>>(StringComparer.Ordinal);

        foreach (var e in expenses)
        {
            var n = For(nets, e.Currency);
            foreach (var p in e.Payers) Add(n, p.MemberId, p.Minor);
            foreach (var s in e.Shares) Add(n, s.MemberId, -s.Minor);
        }

        foreach (var s in settlements)
        {
            var n = For(nets, s.Currency);
            Add(n, s.From, s.Minor);
            Add(n, s.To, -s.Minor);
        }

        return nets.ToDictionary(kv => kv.Key, kv => (IReadOnlyDictionary<Guid, long>)kv.Value, StringComparer.Ordinal);
    }

    private static Dictionary<Guid, long> For(Dictionary<string, Dictionary<Guid, long>> nets, string currency) =>
        nets.TryGetValue(currency, out var n) ? n : nets[currency] = new Dictionary<Guid, long>();

    private static void Add(Dictionary<Guid, long> n, Guid member, long delta) =>
        n[member] = checked(n.GetValueOrDefault(member) + delta);
}
