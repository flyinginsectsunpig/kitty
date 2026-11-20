using System.Text.Json;
using Kitty.Ledger.Data.Entities;

namespace Kitty.Ledger.Features.Scans;

public static class ScanViews
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static string Serialize(ScanSuggestion suggestion) => JsonSerializer.Serialize(suggestion, Json);

    public static ScanSuggestion? Suggestion(ReceiptScan scan) =>
        scan.SuggestionJson is { } json ? JsonSerializer.Deserialize<ScanSuggestion>(json, Json) : null;

    /// <summary>Suggestions are shown only while they are still on offer: read, and not yet applied.</summary>
    public static TableScanDto ToDto(ReceiptScan scan)
    {
        var offer = scan.Status == ScanStatus.Parsed && scan.AppliedAt is null ? Suggestion(scan) : null;
        return new TableScanDto(scan.Id, scan.Status, scan.FailureReason, offer?.Items, offer?.Charges);
    }
}
