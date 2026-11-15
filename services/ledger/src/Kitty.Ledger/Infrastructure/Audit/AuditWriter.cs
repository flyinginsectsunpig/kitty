using System.Text.Json;
using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;

namespace Kitty.Ledger.Infrastructure.Audit;

public static class AuditActions
{
    public const string Created = "created";
    public const string Updated = "updated";
    public const string Deleted = "deleted";
}

/// <summary>Adds an audit row to the request's DbContext; the caller's SaveChanges commits it with the change.</summary>
public sealed class AuditWriter(LedgerDbContext db, TimeProvider clock)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public void Record(Guid actorUserId, Guid groupId, string entityType, Guid entityId, string action, object? before, object? after) =>
        db.AuditEntries.Add(new AuditEntry
        {
            Id = Guid.NewGuid(),
            GroupId = groupId,
            EntityType = entityType,
            EntityId = entityId,
            Action = action,
            ActorUserId = actorUserId,
            At = clock.GetUtcNow(),
            Before = before is null ? null : JsonSerializer.Serialize(before, Json),
            After = after is null ? null : JsonSerializer.Serialize(after, Json),
        });
}
