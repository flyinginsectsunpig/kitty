using Confluent.Kafka;
using Confluent.Kafka.SyncOverAsync;
using Confluent.SchemaRegistry.Serdes;
using Kitty.Contracts.Events.V1;
using Kitty.Ledger.Features.Scans;

namespace Kitty.Ledger.Infrastructure.Messaging;

/// <summary>
/// Reads receipt.parsed (group ledger-scans) and hands each result to <see cref="ScanResultHandler"/>, committing
/// the offset only once it has been applied. A result that keeps failing is retried a few times, then logged and
/// skipped, so one bad message can't stop every other table's scans (the scan times out and offers manual entry).
/// </summary>
public sealed class InboxConsumer(IServiceScopeFactory scopes, KafkaOptions kafka, TimeProvider clock, ILogger<InboxConsumer> log)
    : BackgroundService
{
    public const string GroupId = "ledger-scans";
    private const int Attempts = 5;

    protected override Task ExecuteAsync(CancellationToken stoppingToken) =>
        Task.Factory.StartNew(() => RunAsync(stoppingToken), stoppingToken, TaskCreationOptions.LongRunning, TaskScheduler.Default).Unwrap();

    private async Task RunAsync(CancellationToken ct)
    {
        using var consumer = new ConsumerBuilder<string, ReceiptResult>(new ConsumerConfig
            {
                BootstrapServers = kafka.BootstrapServers,
                GroupId = GroupId,
                AutoOffsetReset = AutoOffsetReset.Earliest,
                EnableAutoCommit = false,
            })
            .SetValueDeserializer(new ProtobufDeserializer<ReceiptResult>().AsSyncOverAsync())
            .Build();
        consumer.Subscribe(Topics.ReceiptParsed);
        try
        {
            while (!ct.IsCancellationRequested)
            {
                ConsumeResult<string, ReceiptResult>? message;
                try
                {
                    message = consumer.Consume(TimeSpan.FromSeconds(1));
                }
                catch (ConsumeException e)
                {
                    log.LogWarning("Could not read {Topic}: {Reason}; retrying", Topics.ReceiptParsed, e.Error.Reason);
                    await Task.Delay(TimeSpan.FromSeconds(1), clock, ct);
                    continue;
                }
                if (message?.Message?.Value is not { } result) continue;

                await HandleAsync(result, ct);
                consumer.Commit(message);
            }
        }
        finally
        {
            consumer.Close();
        }
    }

    private async Task HandleAsync(ReceiptResult result, CancellationToken ct)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                using var scope = scopes.CreateScope();
                await scope.ServiceProvider.GetRequiredService<ScanResultHandler>().ApplyAsync(result, ct);
                return;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                if (attempt >= Attempts)
                {
                    log.LogError(ex, "Giving up on scan result {EventId} for scan {ScanId}", result.EventId, result.ScanId);
                    return;
                }
                log.LogWarning(ex, "Applying scan result {EventId} failed (attempt {Attempt}); retrying", result.EventId, attempt);
                await Task.Delay(TimeSpan.FromSeconds(attempt), clock, ct);
            }
        }
    }
}
