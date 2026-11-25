using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Domain.Balances;
using Kitty.Ledger.Features.Common;

namespace Kitty.Ledger.Features.Settlements;

/// <summary>What one member still owes another on each item, after the payments that said they covered it.</summary>
public static class OpenItems
{
    public sealed record OpenItem(Expense Expense, long Owed, long Open);

    /// <summary>
    /// The items since the debtor was last square on which they still owe the creditor something, newest first.
    /// <paramref name="expenses"/> and <paramref name="liveSettlements"/> are the group's live rows, in every currency.
    /// </summary>
    public static IReadOnlyList<OpenItem> Between(List<Expense> expenses, List<Settlement> liveSettlements, string currency, Guid debtor,
        Guid creditor)
    {
        var effective = Effective(expenses, liveSettlements);
        var covered = new Dictionary<Guid, long>();
        foreach (var s in liveSettlements.Where(s => s.FromMemberId == debtor && s.ToMemberId == creditor))
            foreach (var c in s.Covers)
                covered[c.ExpenseId] = covered.GetValueOrDefault(c.ExpenseId) + effective.GetValueOrDefault((s.Id, c.ExpenseId));

        return LastSquare.Since(RecordedRows.Order(expenses, liveSettlements, currency, debtor)).OfType<Expense>()
            .Select(e =>
            {
                var owed = ItemDebt.Owed(e.Payers, e.Shares, debtor, creditor);
                return new OpenItem(e, owed, owed - covered.GetValueOrDefault(e.Id));
            })
            .Where(i => i.Open > 0)
            .OrderByDescending(i => i.Expense.OccurredOn).ThenByDescending(i => i.Expense.CreatedAt).ThenBy(i => i.Expense.Id)
            .ToList();
    }

    /// <summary>
    /// How much each cover really counts, taking the payments in the order they were recorded: never more than was still
    /// owed on the item between that pair. A race can over-cover an item; the later cover is clamped. A cover on a deleted
    /// expense counts nothing.
    /// </summary>
    public static Dictionary<(Guid SettlementId, Guid ExpenseId), long> Effective(List<Expense> expenses, List<Settlement> liveSettlements)
    {
        var live = expenses.Where(e => e.DeletedAt == null).ToDictionary(e => e.Id);
        var sofar = new Dictionary<(Guid From, Guid To, Guid ExpenseId), long>();
        var result = new Dictionary<(Guid SettlementId, Guid ExpenseId), long>();
        foreach (var s in liveSettlements.OrderBy(s => s.CreatedAt).ThenBy(s => s.Id))
        {
            foreach (var c in s.Covers)
            {
                if (!live.TryGetValue(c.ExpenseId, out var e))
                {
                    result[(s.Id, c.ExpenseId)] = 0;
                    continue;
                }
                var pair = (s.FromMemberId, s.ToMemberId, c.ExpenseId);
                var already = sofar.GetValueOrDefault(pair);
                var counts = Math.Min(c.AmountMinor, Math.Max(0, ItemDebt.Owed(e.Payers, e.Shares, s.FromMemberId, s.ToMemberId) - already));
                sofar[pair] = already + counts;
                result[(s.Id, c.ExpenseId)] = counts;
            }
        }
        return result;
    }
}
