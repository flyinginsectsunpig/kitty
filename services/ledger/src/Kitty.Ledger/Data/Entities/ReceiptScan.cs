namespace Kitty.Ledger.Data.Entities;

public static class ScanStatus
{
    /// <summary>Upload URL issued; the photo may not be there yet. Not shown on the table.</summary>
    public const string AwaitingUpload = "awaiting_upload";
    public const string Parsing = "parsing";
    public const string Parsed = "parsed";
    public const string Failed = "failed";
    /// <summary>A newer scan took over; its photo is deleted and a late result is ignored.</summary>
    public const string Replaced = "replaced";
}

/// <summary>A photo of a table session's receipt and what the ai service made of it.</summary>
public sealed class ReceiptScan
{
    public Guid Id { get; set; }
    public Guid SessionId { get; set; }
    /// <summary>"{sessionId}/{scanId}" in the private "receipts" container.</summary>
    public required string BlobName { get; set; }
    public required string ContentType { get; set; }
    public required string Status { get; set; }
    public string? FailureReason { get; set; }
    /// <summary>The parsed items and charges (with ids), as JSON: applied to an empty bill, else offered to the host.</summary>
    public string? SuggestionJson { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? UploadedAt { get; set; }
    public DateTimeOffset? FinishedAt { get; set; }
    public DateTimeOffset? AppliedAt { get; set; }
    public DateTimeOffset? BlobDeletedAt { get; set; }
}
