using Kitty.Ledger.Features.Common;

namespace Kitty.Ledger.Features.Spending;

public sealed record CategoryTotalDto(string Category, MoneyDto Total);
public sealed record PayerTotalDto(Guid MemberId, string Name, MoneyDto Paid);

/// <summary>One currency's spending. Biggest and Latest: five each.</summary>
public sealed record SpendingCurrencyDto(string Currency, MoneyDto Total, MoneyDto MyShare, int Count,
    IReadOnlyList<CategoryTotalDto> ByCategory, IReadOnlyList<PayerTotalDto> ByPayer, IReadOnlyList<ExpenseLineDto> Biggest,
    IReadOnlyList<ExpenseLineDto> Latest);

/// <summary>The total in the group's currency from each row's stored rate. ExcludedCount: foreign rows with no rate.</summary>
public sealed record ConvertedSpendingDto(MoneyDto Total, int ExcludedCount);

/// <summary>Converted is null unless more than one currency is present.</summary>
public sealed record SpendingDto(string GroupCurrency, IReadOnlyList<SpendingCurrencyDto> Currencies, ConvertedSpendingDto? Converted);
