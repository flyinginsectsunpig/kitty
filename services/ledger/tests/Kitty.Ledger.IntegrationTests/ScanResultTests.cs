using System.Net;
using System.Net.Http.Json;
using Confluent.Kafka;
using Confluent.SchemaRegistry;
using Confluent.SchemaRegistry.Serdes;
using Timestamp = Google.Protobuf.WellKnownTypes.Timestamp;
using Kitty.Contracts.Events.V1;
using Kitty.Ledger.Data;
using Kitty.Ledger.Features.Scans;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Kitty.Ledger.IntegrationTests;

[Collection(ApiCollection.Name)]
public class ScanResultTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private async Task<(HttpClient Host, GroupDto Group, Guid SessionId, Guid ScanId)> ScannedTableAsync()
    {
        var host = factory.NewUser("Host");
        var g = await host.CreateGroupAsync();
        var s = await host.CreateSessionAsync(g.Id, g.Members[0].Id);
        var (scanId, _) = await host.ScanAsync(g.Id, s.Id);
        return (host, g, s.Id, scanId);
    }

    private static ReceiptResult Parsed(Guid sessionId, Guid scanId, string? eventId = null) => new()
    {
        EventId = eventId ?? Guid.NewGuid().ToString(),
        OccurredAt = Timestamp.FromDateTimeOffset(DateTimeOffset.UtcNow),
        ScanId = scanId.ToString(),
        SessionId = sessionId.ToString(),
        Parsed = new ParsedReceipt
        {
            Merchant = "Mzansi Grill", Currency = "ZAR", TotalMinor = 18700,
            Items = { new ParsedItem { Description = "Burger", Quantity = 1, LineTotalMinor = 12000 },
                      new ParsedItem { Description = "Coke", Quantity = 2, LineTotalMinor = 5000 } },
            Charges = { new ParsedCharge { Kind = "tip", AmountMinor = 1700 } },
        },
    };

    private async Task PublishAsync(ReceiptResult result)
    {
        using var registry = new CachedSchemaRegistryClient(new SchemaRegistryConfig { Url = factory.SchemaRegistryUrl });
        using var producer = new ProducerBuilder<string, ReceiptResult>(new ProducerConfig { BootstrapServers = factory.KafkaBootstrap })
            .SetValueSerializer(new ProtobufSerializer<ReceiptResult>(registry)).Build();
        await producer.ProduceAsync("receipt.parsed", new Message<string, ReceiptResult> { Key = result.SessionId, Value = result }, Ct);
    }

    private static async Task<SessionWithScanDto> WaitForAsync(HttpClient host, Guid groupId, Guid sessionId, Func<SessionWithScanDto, bool> done)
    {
        SessionWithScanDto? last = null;
        for (var i = 0; i < 60; i++)
        {
            last = (await host.GetFromJsonAsync<SessionWithScanDto>($"/groups/{groupId}/table-sessions/{sessionId}", ApiClientExtensions.Json, Ct))!;
            if (done(last)) return last;
            await Task.Delay(250, Ct);
        }
        Assert.Fail($"Session never reached the expected state; last scan status: {last?.Scan?.Status}");
        return last!;
    }

    [Fact]
    public async Task Parsed_result_fills_an_empty_session()
    {
        var (host, g, sessionId, scanId) = await ScannedTableAsync();
        await PublishAsync(Parsed(sessionId, scanId));

        var s = await WaitForAsync(host, g.Id, sessionId, x => x.Scan?.Status == "parsed");

        Assert.Equal([("Burger", 1, 12000L), ("Coke", 2, 5000L)], s.Items.Select(i => (i.Description, i.Quantity, i.LineTotalMinor)));
        Assert.Equal(("tip", 1700L), (s.Charges.Single().Kind, s.Charges.Single().AmountMinor));
        Assert.Null(s.Scan!.SuggestedItems); // already applied
    }

    [Fact]
    public async Task Result_never_overwrites_typed_items()
    {
        var host = factory.NewUser("Host");
        var g = await host.CreateGroupAsync();
        var session = await host.CreateSessionAsync(g.Id, g.Members[0].Id);
        var typed = Guid.NewGuid();
        (await host.PutItemsAsync(g.Id, session.Id, (typed, "Pizza", 15000))).EnsureSuccessStatusCode();
        var (scanId, _) = await host.ScanAsync(g.Id, session.Id);

        await PublishAsync(Parsed(session.Id, scanId));
        var s = await WaitForAsync(host, g.Id, session.Id, x => x.Scan?.Status == "parsed");

        Assert.Equal(typed, Assert.Single(s.Items).Id);
        Assert.Equal(["Burger", "Coke"], s.Scan!.SuggestedItems!.Select(i => i.Description));
        Assert.Equal(1700, s.Scan.SuggestedCharges!.Single().AmountMinor);
    }

    [Fact]
    public async Task Result_never_overwrites_a_typed_tip()
    {
        var host = factory.NewUser("Host");
        var g = await host.CreateGroupAsync();
        var session = await host.CreateSessionAsync(g.Id, g.Members[0].Id);
        (await host.PutJsonAsync($"/groups/{g.Id}/table-sessions/{session.Id}/charges",
            new { charges = new[] { new { id = Guid.NewGuid(), kind = "tip", amountMinor = 5000 } } })).EnsureSuccessStatusCode();
        var (scanId, _) = await host.ScanAsync(g.Id, session.Id);

        await PublishAsync(Parsed(session.Id, scanId));
        var s = await WaitForAsync(host, g.Id, session.Id, x => x.Scan?.Status == "parsed");

        Assert.Equal(5000, s.Charges.Single().AmountMinor);
        Assert.Empty(s.Items);
        Assert.Equal(2, s.Scan!.SuggestedItems!.Count);
    }

    [Fact]
    public async Task Result_waits_for_a_save_in_progress_and_then_only_suggests()
    {
        // The host's save holds the bill's row lock; a scan result arriving meanwhile must not read the bill as
        // empty and add its items next to the typed ones.
        var host = factory.NewUser("Host");
        var g = await host.CreateGroupAsync();
        var session = await host.CreateSessionAsync(g.Id, g.Members[0].Id);
        var (scanId, _) = await host.ScanAsync(g.Id, session.Id);

        using var saving = factory.Services.CreateScope();
        var db = saving.ServiceProvider.GetRequiredService<LedgerDbContext>();
        await using var tx = await db.Database.BeginTransactionAsync(Ct);
        await db.Database.ExecuteSqlInterpolatedAsync($"""UPDATE "ReceiptSessions" SET "Version" = "Version" + 1 WHERE "Id" = {session.Id}""", Ct);
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"""INSERT INTO "ReceiptItems" ("Id", "SessionId", "Description", "Quantity", "LineTotalMinor", "Position") VALUES ({Guid.NewGuid()}, {session.Id}, 'Pizza', 1, 15000, 0)""", Ct);

        var applying = Task.Run(async () =>
        {
            using var scope = factory.Services.CreateScope();
            await scope.ServiceProvider.GetRequiredService<ScanResultHandler>().ApplyAsync(Parsed(session.Id, scanId), Ct);
        }, Ct);
        await Task.Delay(1000, Ct);
        await tx.CommitAsync(Ct);
        await applying;

        var s = (await host.GetFromJsonAsync<SessionWithScanDto>($"/groups/{g.Id}/table-sessions/{session.Id}", ApiClientExtensions.Json, Ct))!;
        Assert.Equal(["Pizza"], s.Items.Select(i => i.Description));
        Assert.Equal(2, s.Scan!.SuggestedItems!.Count);
    }

    [Fact]
    public async Task Duplicate_result_is_applied_once()
    {
        var (host, g, sessionId, scanId) = await ScannedTableAsync();
        var result = Parsed(sessionId, scanId);
        await PublishAsync(result);
        var first = await WaitForAsync(host, g.Id, sessionId, x => x.Scan?.Status == "parsed");

        await PublishAsync(result);
        await PublishAsync(Parsed(sessionId, scanId)); // a different event for the same scan: also ignored, it's no longer parsing
        await Task.Delay(3000, Ct);
        var after = await WaitForAsync(host, g.Id, sessionId, _ => true);

        Assert.Equal(2, after.Items.Count);
        Assert.Equal(first.Version, after.Version);
    }

    [Fact]
    public async Task Failed_result_sets_reason()
    {
        var (host, g, sessionId, scanId) = await ScannedTableAsync();
        await PublishAsync(new ReceiptResult
        {
            EventId = Guid.NewGuid().ToString(), OccurredAt = Timestamp.FromDateTimeOffset(DateTimeOffset.UtcNow),
            ScanId = scanId.ToString(), SessionId = sessionId.ToString(),
            Failed = new ScanFailure { Reason = ScanFailure.Types.Reason.RateLimited },
        });

        var s = await WaitForAsync(host, g.Id, sessionId, x => x.Scan?.Status == "failed");
        Assert.Equal("rate_limited", s.Scan!.FailureReason);
        Assert.Empty(s.Items);
    }

    [Fact]
    public async Task Host_applies_suggestion()
    {
        var host = factory.NewUser("Host");
        var g = await host.CreateGroupAsync();
        var session = await host.CreateSessionAsync(g.Id, g.Members[0].Id);
        (await host.PutItemsAsync(g.Id, session.Id, (Guid.NewGuid(), "Pizza", 15000))).EnsureSuccessStatusCode();
        var (scanId, _) = await host.ScanAsync(g.Id, session.Id);
        await PublishAsync(Parsed(session.Id, scanId));
        await WaitForAsync(host, g.Id, session.Id, x => x.Scan?.Status == "parsed");
        var url = $"/groups/{g.Id}/table-sessions/{session.Id}/scans/{scanId}/apply";

        var friend = factory.NewUser("Friend");
        await friend.JoinAsync(host, g.Id);
        Assert.Equal("host_only", await (await friend.PostJsonAsync(url, new { })).ReadCodeAsync());

        var r = await host.PostJsonAsync(url, new { });
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var s = await r.ReadAsync<SessionWithScanDto>();
        Assert.Equal(["Burger", "Coke"], s.Items.Select(i => i.Description));
        Assert.Equal(1700, s.Charges.Single().AmountMinor);
        Assert.Null(s.Scan!.SuggestedItems);
    }

    [Fact]
    public async Task Result_for_a_replaced_scan_is_ignored()
    {
        var (host, g, sessionId, firstScan) = await ScannedTableAsync();
        var (secondScan, _) = await host.ScanAsync(g.Id, sessionId);

        await PublishAsync(Parsed(sessionId, firstScan));
        await Task.Delay(3000, Ct);
        var s = await WaitForAsync(host, g.Id, sessionId, _ => true);

        Assert.Equal((secondScan, "parsing"), (s.Scan!.Id, s.Scan.Status));
        Assert.Empty(s.Items);
    }
}
