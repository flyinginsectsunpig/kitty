using Confluent.Kafka;
using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Infrastructure.Messaging;

/// <summary>
/// Publishes outbox rows to Kafka, oldest first, and marks them sent. At-least-once: a crash between publishing
/// and marking re-sends the row, and consumers dedupe by event id. A row that fails stops the batch, so later
/// events for the same key never overtake it. One relay works at a time (a Postgres advisory lock), which keeps
/// that order with more than one ledger replica.
/// </summary>
public sealed class OutboxRelay(IServiceScopeFactory scopes, KafkaOptions kafka, EventSerializers serializers,
    TimeProvider clock, ILogger<OutboxRelay> log) : BackgroundService
{
    public const int BatchSize = 100;
    private const long LockKey = 0x4B4954_4F5554; // "KITOUT"
    private static readonly TimeSpan Idle = TimeSpan.FromMilliseconds(500);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var producer = new ProducerBuilder<string, byte[]>(new ProducerConfig
        {
            BootstrapServers = kafka.BootstrapServers,
            EnableIdempotence = true,
            Acks = Acks.All,
        }).Build();

        await EnsureTopicsAsync(stoppingToken);
        while (!stoppingToken.IsCancellationRequested)
        {
            var sent = 0;
            try
            {
                sent = await RelayBatchAsync(producer, stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogWarning(ex, "Outbox relay failed; retrying");
            }
            if (sent < BatchSize) await Task.Delay(Idle, clock, stoppingToken);
        }
    }

    private async Task<int> RelayBatchAsync(IProducer<string, byte[]> producer, CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<LedgerDbContext>();
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var locked = await db.Database.SqlQuery<bool>($"SELECT pg_try_advisory_xact_lock({LockKey}) AS \"Value\"").SingleAsync(ct);
        if (!locked) return 0;

        var batch = await db.OutboxMessages.Where(m => m.SentAt == null).OrderBy(m => m.OccurredAt).ThenBy(m => m.Id)
            .Take(BatchSize).ToListAsync(ct);
        var sent = 0;
        foreach (var message in batch)
        {
            try
            {
                var value = await serializers.SerializeAsync(message.Type, message.Payload, message.Topic);
                await producer.ProduceAsync(message.Topic, new Message<string, byte[]> { Key = message.Key, Value = value }, ct);
                message.SentAt = clock.NowMicros();
                sent++;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                message.Attempts++;
                log.LogWarning(ex, "Could not publish outbox message {Id} ({Type}, attempt {Attempts})", message.Id, message.Type, message.Attempts);
                break;
            }
        }
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return sent;
    }

    private async Task EnsureTopicsAsync(CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                using var admin = new AdminClientBuilder(new AdminClientConfig { BootstrapServers = kafka.BootstrapServers }).Build();
                await Topics.EnsureAsync(admin);
                return;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogWarning(ex, "Kafka is not reachable yet; retrying topic setup");
                await Task.Delay(TimeSpan.FromSeconds(Math.Min(30, 1 << Math.Min(attempt, 5))), clock, ct);
            }
        }
    }
}
