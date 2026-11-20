namespace Kitty.Ledger.Data.Entities;

/// <summary>An event this ledger has already handled; Kafka delivers at least once, so handlers check here first.</summary>
public sealed class InboxMessage
{
    public required string EventId { get; set; }
    public required string Topic { get; set; }
    public DateTimeOffset ProcessedAt { get; set; }
}
