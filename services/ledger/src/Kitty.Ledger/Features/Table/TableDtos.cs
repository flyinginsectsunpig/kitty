namespace Kitty.Ledger.Features.Table;

public sealed record CreateTableSessionDto(Guid Id, string Title, string Currency, Guid PayerMemberId);
public sealed record ItemWriteDto(Guid Id, string Description, int Quantity, long LineTotalMinor);
public sealed record ReplaceItemsDto(IReadOnlyList<ItemWriteDto> Items);
public sealed record ChargeWriteDto(Guid Id, string Kind, long AmountMinor);
public sealed record ReplaceChargesDto(IReadOnlyList<ChargeWriteDto> Charges);
public sealed record MapGuestDto(Guid? MemberId);

/// <summary>Who claimed something: a member, or a guest not yet mapped to a member.</summary>
public sealed record ClaimantDto(string Kind, Guid Id, string DisplayName);
public sealed record TableItemDto(Guid Id, string Description, int Quantity, long LineTotalMinor, IReadOnlyList<ClaimantDto> Claimants);
public sealed record TableChargeDto(Guid Id, string Kind, long AmountMinor);
public sealed record TableGuestDto(Guid Id, string DisplayName, Guid? MappedMemberId);
public sealed record PreviewShareDto(string Kind, Guid Id, string DisplayName, long AmountMinor);

public sealed record TableSessionDto(
    Guid Id,
    string Title,
    string Currency,
    string Status,
    int Version,
    Guid PayerMemberId,
    Guid? ExpenseId,
    IReadOnlyList<TableItemDto> Items,
    IReadOnlyList<TableChargeDto> Charges,
    IReadOnlyList<TableGuestDto> Guests,
    IReadOnlyList<PreviewShareDto> Preview);
