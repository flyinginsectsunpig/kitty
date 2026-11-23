using Google.Protobuf;
using Google.Protobuf.WellKnownTypes;
using Kitty.Contracts.Events.V1;
using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Infrastructure;

namespace Kitty.Ledger.Infrastructure.Messaging;

/// <summary>
/// Queues an event in the caller's unit of work. It is saved by the caller's SaveChanges, inside the same
/// transaction as the change, so a rolled-back change never leaves an event behind.
/// </summary>
public sealed class Outbox(LedgerDbContext db, TimeProvider clock)
{
    public void Add<T>(string topic, string key, T message) where T : IMessage<T> =>
        db.OutboxMessages.Add(new OutboxMessage
        {
            Id = Guid.CreateVersion7(),
            Topic = topic,
            Key = key,
            Type = message.Descriptor.FullName,
            Payload = message.ToByteArray(),
            OccurredAt = clock.NowMicros(),
        });

    public void ExpenseChanged(Guid groupId, Guid expenseId, ExpenseChanged.Types.Change change) =>
        Add(Topics.LedgerEvents, groupId.ToString(), new ExpenseChanged
        {
            EventId = Guid.NewGuid().ToString(),
            OccurredAt = Timestamp.FromDateTimeOffset(clock.GetUtcNow()),
            GroupId = groupId.ToString(),
            ExpenseId = expenseId.ToString(),
            Change = change,
        });
}
