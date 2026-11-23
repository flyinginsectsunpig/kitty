using Kitty.Ledger.Features.Table;

namespace Kitty.Ledger.Features.Scans;

public sealed record StartScanDto(Guid Id, string ContentType);
public sealed record StartScanResultDto(Guid ScanId, Uri UploadUrl, DateTimeOffset ExpiresAt, long MaxBytes);

/// <summary>
/// The latest receipt scan on a table. Suggested items and charges are present when the scan was read but not
/// applied (the host had already typed items); the host can apply them.
/// </summary>
public sealed record TableScanDto(Guid Id, string Status, string? FailureReason,
    IReadOnlyList<ItemWriteDto>? SuggestedItems, IReadOnlyList<ChargeWriteDto>? SuggestedCharges);

/// <summary>What a scan read, stored as JSON on the scan (ids included, so applying it is repeatable).</summary>
public sealed record ScanSuggestion(IReadOnlyList<ItemWriteDto> Items, IReadOnlyList<ChargeWriteDto> Charges);
