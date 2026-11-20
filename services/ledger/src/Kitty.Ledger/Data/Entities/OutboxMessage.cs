namespace Kitty.Ledger.Data.Entities;

/// <summary>
/// An event waiting to be published. Written in the same transaction as the change it describes, so an event
/// exists if and only if the change committed; the relay publishes it to Kafka and sets <see cref="SentAt"/>.
/// </summary>
public sealed class OutboxMessage
{
    public Guid Id { get; set; }
    public required string Topic { get; set; }
    public required string Key { get; set; }
    /// <summary>Protobuf full name, e.g. kitty.events.v1.ExpenseChanged.</summary>
    public required string Type { get; set; }
    public required byte[] Payload { get; set; }
    public DateTimeOffset OccurredAt { get; set; }
    public DateTimeOffset? SentAt { get; set; }
    public int Attempts { get; set; }
}
