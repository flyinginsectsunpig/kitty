using Kitty.Ledger.Data.Entities;

namespace Kitty.Ledger.Features.Common;

/// <summary>One expense as Ask Kitty lists it. PaidBy: the payers' member names joined " and ".</summary>
public sealed record ExpenseLineDto(Guid ExpenseId, string Description, DateOnly Date, string Category, MoneyDto Total, MoneyDto MyShare,
    string PaidBy)
{
    public static ExpenseLineDto Of(Expense e, Guid me, IReadOnlyDictionary<Guid, string> names)
    {
        var currency = e.Currency.Trim();
        string Name(Guid id) => names.GetValueOrDefault(id) ?? "someone";
        var paidBy = e.Payers.OrderByDescending(p => p.AmountMinor).ThenBy(p => Name(p.MemberId), StringComparer.Ordinal)
            .Select(p => Name(p.MemberId));
        return new ExpenseLineDto(e.Id, e.Description, e.OccurredOn, e.Category, MoneyDto.Of(e.AmountMinor, currency),
            MoneyDto.Of(e.Shares.Where(s => s.MemberId == me).Sum(s => s.AmountMinor), currency), string.Join(" and ", paidBy));
    }
}
