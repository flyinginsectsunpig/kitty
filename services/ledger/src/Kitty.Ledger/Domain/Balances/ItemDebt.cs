using Kitty.Ledger.Data.Entities;

namespace Kitty.Ledger.Domain.Balances;

public static class ItemDebt
{
    /// <summary>
    /// What <paramref name="debtor"/> owes <paramref name="creditor"/> on one item: the debtor's share, divided among
    /// the payers in proportion to what each paid. Parts are floored; leftover minor units go one each to the largest
    /// fractional remainders, ties to the lower MemberId. Zero for self, a non-payer creditor, or a debtor with no share.
    /// </summary>
    public static long Owed(IReadOnlyList<ExpensePayer> payers, IReadOnlyList<ExpenseShare> shares, Guid debtor, Guid creditor)
    {
        if (debtor == creditor) return 0;
        var share = shares.Where(s => s.MemberId == debtor).Sum(s => s.AmountMinor);
        var paid = payers.Sum(p => p.AmountMinor);
        if (share == 0 || paid == 0) return 0;

        var parts = payers
            .Select(p =>
            {
                var numerator = (decimal)share * p.AmountMinor;
                var floor = (long)decimal.Floor(numerator / paid);
                return (p.MemberId, Floor: floor, Remainder: numerator - (decimal)floor * paid);
            })
            .ToList();

        var leftover = share - parts.Sum(p => p.Floor);
        var lucky = parts
            .OrderByDescending(p => p.Remainder)
            .ThenBy(p => p.MemberId)
            .Take((int)leftover)
            .Select(p => p.MemberId)
            .ToHashSet();

        return parts.Where(p => p.MemberId == creditor).Sum(p => p.Floor + (lucky.Contains(p.MemberId) ? 1 : 0));
    }
}
