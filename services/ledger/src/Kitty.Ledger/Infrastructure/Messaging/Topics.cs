using Confluent.Kafka;
using Confluent.Kafka.Admin;

namespace Kitty.Ledger.Infrastructure.Messaging;

public static class Topics
{
    public const string LedgerEvents = "ledger.events";
    /// <summary>Each recurring schedule's latest state, keyed by schedule id; log-compacted.</summary>
    public const string LedgerRecurring = "ledger.recurring";
    public const string ReceiptUploaded = "receipt.uploaded";
    public const string ReceiptUploadedRetry = "receipt.uploaded.retry";
    public const string ReceiptParsed = "receipt.parsed";

    public static readonly string[] All = [LedgerEvents, LedgerRecurring, ReceiptUploaded, ReceiptUploadedRetry, ReceiptParsed];

    private static readonly HashSet<string> Compacted = [LedgerRecurring];

    /// <summary>Creates any missing topic (3 partitions, replication 1: one broker).</summary>
    public static async Task EnsureAsync(IAdminClient admin)
    {
        var existing = admin.GetMetadata(TimeSpan.FromSeconds(10)).Topics.Select(t => t.Topic).ToHashSet();
        var missing = All.Where(t => !existing.Contains(t))
            .Select(t => new TopicSpecification
            {
                Name = t, NumPartitions = 3, ReplicationFactor = 1,
                Configs = Compacted.Contains(t) ? new Dictionary<string, string> { ["cleanup.policy"] = "compact" } : null,
            }).ToList();
        if (missing.Count == 0) return;
        try
        {
            await admin.CreateTopicsAsync(missing);
        }
        catch (CreateTopicsException e) when (e.Results.All(r => r.Error.Code is ErrorCode.NoError or ErrorCode.TopicAlreadyExists))
        {
            // Another instance created them first.
        }
    }
}
