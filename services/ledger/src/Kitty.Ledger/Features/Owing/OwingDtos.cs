using Kitty.Ledger.Features.Common;

namespace Kitty.Ledger.Features.Owing;

/// <summary>Direction: "i_pay" or "pays_me". From the group's settle-up plan, as /balances.</summary>
public sealed record OwingTransferDto(string Direction, Guid MemberId, string Name, MoneyDto Amount);

/// <summary>A settlement involving me. Date: when it was recorded, in South African time.</summary>
public sealed record OwingPaymentDto(string From, string To, MoneyDto Amount, DateOnly Date);

/// <summary>Since: the expenses involving me after I was last square in this currency, newest first, at most ten.</summary>
public sealed record OwingCurrencyDto(string Currency, MoneyDto MyNet, IReadOnlyList<OwingTransferDto> Transfers,
    IReadOnlyList<ExpenseLineDto> Since, int MoreSince, IReadOnlyList<OwingPaymentDto> Payments);

public sealed record OwingGroupDto(Guid Id, string Name, IReadOnlyList<OwingCurrencyDto> Currencies);

/// <summary>A person with an account (UserId, their account name), or a placeholder in one group (MemberId). Never merged by name.</summary>
public sealed record OwingPersonDto(Guid? UserId, Guid? MemberId, string Name, IReadOnlyList<MoneyDto> IOwe, IReadOnlyList<MoneyDto> OwesMe,
    IReadOnlyList<string> Groups);

/// <summary>What I owe and am owed across my groups, per currency. The two are never netted and never converted.</summary>
public sealed record OwingDto(IReadOnlyList<MoneyDto> IOwe, IReadOnlyList<MoneyDto> OwedToMe, IReadOnlyList<OwingPersonDto> People,
    IReadOnlyList<OwingGroupDto> Groups);
