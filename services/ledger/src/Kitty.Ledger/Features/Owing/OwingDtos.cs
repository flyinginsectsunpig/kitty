using Kitty.Ledger.Features.Common;

namespace Kitty.Ledger.Features.Owing;

/// <summary>Direction: "i_pay" or "pays_me". From the group's settle-up plan, as /balances.</summary>
public sealed record OwingTransferDto(string Direction, Guid MemberId, string Name, MoneyDto Amount);

/// <summary>
/// A settlement involving me. Date: when it was recorded, in South African time. Unallocated: the part of it not
/// counted against any item it covers.
/// </summary>
public sealed record OwingPaymentDto(string From, string To, MoneyDto Amount, DateOnly Date, MoneyDto Unallocated);

/// <summary>Who an item is still open with. Direction: "i_pay" (I owe them Amount on it) or "pays_me" (they owe me).</summary>
public sealed record OpenWithDto(Guid MemberId, string Name, string Direction, MoneyDto Amount);

/// <summary>One expense as <see cref="ExpenseLineDto"/>, with what's still open on it between me and each other member.</summary>
public sealed record OwingLineDto(Guid ExpenseId, string Description, DateOnly Date, string Category, MoneyDto Total, MoneyDto MyShare,
    string PaidBy, IReadOnlyList<OpenWithDto> Open);

/// <summary>
/// Since: the expenses with something still open between me and another member, newest first, at most ten.
/// Payments: the settlements involving me after I was last square in this currency.
/// </summary>
public sealed record OwingCurrencyDto(string Currency, MoneyDto MyNet, IReadOnlyList<OwingTransferDto> Transfers,
    IReadOnlyList<OwingLineDto> Since, int MoreSince, IReadOnlyList<OwingPaymentDto> Payments);

public sealed record OwingGroupDto(Guid Id, string Name, IReadOnlyList<OwingCurrencyDto> Currencies);

/// <summary>A person with an account (UserId, their account name), or a placeholder in one group (MemberId). Never merged by name.</summary>
public sealed record OwingPersonDto(Guid? UserId, Guid? MemberId, string Name, IReadOnlyList<MoneyDto> IOwe, IReadOnlyList<MoneyDto> OwesMe,
    IReadOnlyList<string> Groups);

/// <summary>What I owe and am owed across my groups, per currency. The two are never netted and never converted.</summary>
public sealed record OwingDto(IReadOnlyList<MoneyDto> IOwe, IReadOnlyList<MoneyDto> OwedToMe, IReadOnlyList<OwingPersonDto> People,
    IReadOnlyList<OwingGroupDto> Groups);
