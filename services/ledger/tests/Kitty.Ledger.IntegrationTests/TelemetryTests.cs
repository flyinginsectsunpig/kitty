using System.Collections.Concurrent;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Text;
using Confluent.Kafka;
using Confluent.SchemaRegistry;
using Confluent.SchemaRegistry.Serdes;
using Kitty.Contracts.Events.V1;
using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Kitty.Ledger.IntegrationTests;

/// <summary>Phase 5b: a receipt's trace crosses Kafka both ways, and expenses are counted.</summary>
[Collection(ApiCollection.Name)]
public sealed class TelemetryTests : IDisposable
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private readonly LedgerApiFactory factory;
    private readonly ConcurrentBag<Activity> _stopped = [];
    private readonly ActivityListener _listener;

    public TelemetryTests(LedgerApiFactory factory)
    {
        this.factory = factory;
        // Without a listener ASP.NET Core and the ledger create no activities (as in production without an endpoint).
        _listener = new ActivityListener
        {
            ShouldListenTo = _ => true,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
            ActivityStopped = a => _stopped.Add(a),
        };
        ActivitySource.AddActivityListener(_listener);
    }

    public void Dispose() => _listener.Dispose();

    private static string NewTraceParent(out ActivityTraceId traceId)
    {
        traceId = ActivityTraceId.CreateRandom();
        return $"00-{traceId}-{ActivitySpanId.CreateRandom()}-01";
    }

    [Fact]
    public async Task Receipt_upload_message_carries_traceparent()
    {
        var host = factory.NewUser("Host");
        var g = await host.CreateGroupAsync();
        var s = await host.CreateSessionAsync(g.Id, g.Members[0].Id);
        var start = await host.StartScanAsync(g.Id, s.Id);
        await ScanData.UploadAsync(start.UploadUrl, ScanData.Jpeg);

        var traceparent = NewTraceParent(out var traceId);
        using var confirm = new HttpRequestMessage(HttpMethod.Post, $"/groups/{g.Id}/table-sessions/{s.Id}/scans/{start.ScanId}/uploaded")
        {
            Content = new StringContent("{}", Encoding.UTF8, "application/json"),
        };
        confirm.Headers.Add("traceparent", traceparent);
        confirm.Headers.Add("Idempotency-Key", Guid.NewGuid().ToString());
        (await host.SendAsync(confirm, Ct)).EnsureSuccessStatusCode();

        var (_, _, headers) = Assert.Single(await KafkaProbe.WaitForWithHeadersAsync<ReceiptUploaded>(
            factory, "receipt.uploaded", e => e.ScanId == start.ScanId.ToString()));
        Assert.True(headers.TryGetValue("traceparent", out var sent), "no traceparent header");
        Assert.Equal(traceId.ToString(), sent!.Split('-')[1]); // the same trace as the upload request
    }

    [Fact]
    public async Task Old_outbox_rows_without_trace_still_publish()
    {
        var id = Guid.NewGuid();
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<LedgerDbContext>();
            var e = new ExpenseChanged { EventId = id.ToString(), GroupId = id.ToString(), ExpenseId = id.ToString() };
            db.OutboxMessages.Add(new OutboxMessage
            {
                Id = Guid.CreateVersion7(), Topic = "ledger.events", Key = id.ToString(), Type = ExpenseChanged.Descriptor.FullName,
                Payload = Google.Protobuf.MessageExtensions.ToByteArray(e), OccurredAt = DateTimeOffset.UtcNow, TraceParent = null,
            });
            await db.SaveChangesAsync(Ct);
        }

        var (_, _, headers) = Assert.Single(await KafkaProbe.WaitForWithHeadersAsync<ExpenseChanged>(
            factory, "ledger.events", e => e.EventId == id.ToString()));
        Assert.False(headers.ContainsKey("traceparent"));
    }

    [Fact]
    public async Task Parsed_result_continues_the_upload_trace()
    {
        var host = factory.NewUser("Host");
        var g = await host.CreateGroupAsync();
        var s = await host.CreateSessionAsync(g.Id, g.Members[0].Id);
        var (scanId, _) = await host.ScanAsync(g.Id, s.Id);
        var traceparent = NewTraceParent(out var traceId);
        var result = new ReceiptResult
        {
            EventId = Guid.NewGuid().ToString(), OccurredAt = Google.Protobuf.WellKnownTypes.Timestamp.FromDateTimeOffset(DateTimeOffset.UtcNow),
            ScanId = scanId.ToString(), SessionId = s.Id.ToString(),
            Failed = new ScanFailure { Reason = ScanFailure.Types.Reason.Unreadable },
        };

        using var registry = new CachedSchemaRegistryClient(new SchemaRegistryConfig { Url = factory.SchemaRegistryUrl });
        using var producer = new ProducerBuilder<string, ReceiptResult>(new ProducerConfig { BootstrapServers = factory.KafkaBootstrap })
            .SetValueSerializer(new ProtobufSerializer<ReceiptResult>(registry)).Build();
        await producer.ProduceAsync("receipt.parsed", new Message<string, ReceiptResult>
        {
            Key = result.SessionId, Value = result,
            Headers = new Headers { { "traceparent", Encoding.UTF8.GetBytes(traceparent) } },
        }, Ct);

        for (var i = 0; i < 80 && !_stopped.Any(a => a.OperationName == "receipt.parsed process" && a.TraceId == traceId); i++)
            await Task.Delay(250, Ct);
        Assert.Contains(_stopped, a => a.OperationName == "receipt.parsed process" && a.TraceId == traceId);
    }

    [Fact]
    public async Task Expense_create_counts_once()
    {
        var points = new ConcurrentBag<(long Value, string? SplitType)>();
        using var meters = new MeterListener
        {
            InstrumentPublished = (instrument, l) =>
            {
                if (instrument.Meter.Name == "Kitty.Ledger" && instrument.Name == "kitty.expenses.created") l.EnableMeasurementEvents(instrument);
            },
        };
        meters.SetMeasurementEventCallback<long>((_, value, tags, _) =>
        {
            string? split = null;
            foreach (var t in tags) if (t.Key == "split_type") split = t.Value as string;
            points.Add((value, split));
        });
        meters.Start();

        var alice = factory.NewUser("Alice");
        var g = await alice.CreateGroupAsync();
        var me = g.Members[0].Id;
        await alice.AddEqualAsync(g.Id, 30000, me, [me]);

        Assert.Contains((1L, "equal"), points);
    }
}
