using Kitty.Ledger.Data.Entities;

namespace Kitty.Ledger.Features.Common;

public static class RecordedRows
{
    /// <summary>The rows involving a member in one currency, in the order they were recorded, with what each did to their net.</summary>
    public static List<(object Row, long MyDelta)> Order(List<Expense> expenses, List<Settlement> settlements, string currency,
        Guid member)
    {
        var rows = new List<(object Row, DateTimeOffset At, Guid Id, long MyDelta)>();
        foreach (var e in expenses.Where(e => e.Currency.Trim() == currency))
        {
            if (!e.Payers.Any(p => p.MemberId == member) && !e.Shares.Any(s => s.MemberId == member)) continue;
            var paid = e.Payers.Where(p => p.MemberId == member).Sum(p => p.AmountMinor);
            var share = e.Shares.Where(s => s.MemberId == member).Sum(s => s.AmountMinor);
            rows.Add((e, e.CreatedAt, e.Id, paid - share));
        }
        foreach (var s in settlements.Where(s => s.Currency.Trim() == currency))
        {
            if (s.FromMemberId == member) rows.Add((s, s.CreatedAt, s.Id, s.AmountMinor));
            else if (s.ToMemberId == member) rows.Add((s, s.CreatedAt, s.Id, -s.AmountMinor));
        }
        return rows.OrderBy(r => r.At).ThenBy(r => r.Id).Select(r => (r.Row, r.MyDelta)).ToList();
    }
}
