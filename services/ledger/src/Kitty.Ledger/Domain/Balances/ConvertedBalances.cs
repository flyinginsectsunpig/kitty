using Kitty.Ledger.Domain.Fx;
using Kitty.Ledger.Domain.Splits;

namespace Kitty.Ledger.Domain.Balances;

/// <summary>An expense with the rate stored on it (null: none yet, or the group's own currency).</summary>
public sealed record ConvertibleExpense(string Currency, decimal? FxRate, IReadOnlyList<Share> Payers, IReadOnlyList<Share> Shares);

/// <summary>A settlement with its stored converted amount (null: none, or the group's own currency).</summary>
public sealed record ConvertibleSettlement(string Currency, Guid From, Guid To, long Minor, long? ConvertedMinor);

/// <summary>
/// Everyone's net in the group's currency, using each row's own stored rate (never today's), so it only changes when
/// someone edits something. A view on top of the per-currency balances, which stay the truth. Foreign rows with no
/// stored rate are left out and counted.
/// </summary>
public static class ConvertedBalances
{
    public static (IReadOnlyDictionary<Guid, long> Nets, int Excluded) Compute(string groupCurrency,
        IEnumerable<ConvertibleExpense> expenses, IEnumerable<ConvertibleSettlement> settlements)
    {
        var excluded = 0;
        var inGroupCurrency = new List<LedgerExpense>();
        foreach (var e in expenses)
        {
            if (e.Currency == groupCurrency)
                inGroupCurrency.Add(new LedgerExpense(groupCurrency, e.Payers, e.Shares));
            else if (e.FxRate is { } rate)
                inGroupCurrency.Add(new LedgerExpense(groupCurrency,
                    FxConverter.Spread(e.Payers, rate, e.Currency, groupCurrency),
                    FxConverter.Spread(e.Shares, rate, e.Currency, groupCurrency)));
            else
                excluded++;
        }

        var settled = new List<LedgerSettlement>();
        foreach (var s in settlements)
        {
            if (s.Currency == groupCurrency)
                settled.Add(new LedgerSettlement(groupCurrency, s.From, s.To, s.Minor));
            else if (s.ConvertedMinor is { } converted)
                settled.Add(new LedgerSettlement(groupCurrency, s.From, s.To, converted));
            else
                excluded++;
        }

        var nets = BalanceCalculator.NetByCurrency(inGroupCurrency, settled);
        return (nets.GetValueOrDefault(groupCurrency) ?? new Dictionary<Guid, long>(), excluded);
    }
}
