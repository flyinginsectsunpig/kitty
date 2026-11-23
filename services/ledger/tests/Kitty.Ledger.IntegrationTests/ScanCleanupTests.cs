using System.Net.Http.Json;
using Azure.Storage.Blobs;
using Kitty.Ledger.Data;
using Kitty.Ledger.Features.Scans;
using Kitty.Ledger.Infrastructure.Blob;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;

namespace Kitty.Ledger.IntegrationTests;

[Collection(ApiCollection.Name)]
public class ScanCleanupTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private async Task<(HttpClient Host, GroupDto Group, TableSessionDto Session)> TableAsync()
    {
        var host = factory.NewUser("Host");
        var g = await host.CreateGroupAsync();
        return (host, g, await host.CreateSessionAsync(g.Id, g.Members[0].Id));
    }

    /// <summary>Runs one cleanup pass as if the clock read now + <paramref name="later"/>.</summary>
    private Task<CleanupReport> RunAtAsync(TimeSpan later)
    {
        var clock = new FakeTimeProvider(DateTimeOffset.UtcNow + later);
        var cleanup = new ScanCleanup(factory.Services.GetRequiredService<IServiceScopeFactory>(),
            factory.Services.GetRequiredService<ReceiptBlobs>(), clock, NullLogger<ScanCleanup>.Instance);
        return cleanup.RunOnceAsync(Ct);
    }

    private async Task<string> ScanStatusAsync(Guid scanId)
    {
        using var scope = factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<LedgerDbContext>().ReceiptScans.Where(s => s.Id == scanId).Select(s => s.Status).SingleAsync(Ct);
    }

    private Task<bool> BlobExistsAsync(Guid sessionId, Guid scanId) =>
        new BlobServiceClient(factory.BlobConnectionString).GetBlobContainerClient("receipts")
            .GetBlobClient($"{sessionId}/{scanId}").ExistsAsync(Ct).ContinueWith(t => t.Result.Value, Ct);

    [Fact]
    public async Task Parsing_scan_times_out_after_10_minutes()
    {
        var (host, g, s) = await TableAsync();
        var (scanId, before) = await host.ScanAsync(g.Id, s.Id);

        await RunAtAsync(TimeSpan.FromMinutes(9));
        Assert.Equal("parsing", await ScanStatusAsync(scanId));

        await RunAtAsync(TimeSpan.FromMinutes(11));
        var after = await host.GetFromJsonAsync<SessionWithScanDto>($"/groups/{g.Id}/table-sessions/{s.Id}", ApiClientExtensions.Json, Ct);
        Assert.Equal(("failed", "timed_out"), (after!.Scan!.Status, after.Scan.FailureReason));
        Assert.True(after.Version > before.Version);
    }

    [Fact]
    public async Task Blob_is_deleted_90_days_after_the_bill_closes()
    {
        var (host, g, s) = await TableAsync();
        var (scanId, _) = await host.ScanAsync(g.Id, s.Id);
        (await host.PostJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/cancel", new { })).EnsureSuccessStatusCode();

        await RunAtAsync(TimeSpan.FromDays(89));
        Assert.True(await BlobExistsAsync(s.Id, scanId));

        await RunAtAsync(TimeSpan.FromDays(91));
        Assert.False(await BlobExistsAsync(s.Id, scanId));
        using var scope = factory.Services.CreateScope();
        var scan = await scope.ServiceProvider.GetRequiredService<LedgerDbContext>().ReceiptScans.SingleAsync(x => x.Id == scanId, Ct);
        Assert.NotNull(scan.BlobDeletedAt);
    }

    [Fact]
    public async Task Replaced_photo_is_deleted_even_if_the_first_delete_failed()
    {
        var (host, g, s) = await TableAsync();
        var (first, _) = await host.ScanAsync(g.Id, s.Id);
        await host.ScanAsync(g.Id, s.Id);
        // As if deleting the replaced photo had failed: it is still stored and not marked deleted.
        await new BlobServiceClient(factory.BlobConnectionString).GetBlobContainerClient("receipts")
            .GetBlobClient($"{s.Id}/{first}").UploadAsync(new BinaryData(ScanData.Jpeg), overwrite: true, Ct);
        using (var scope = factory.Services.CreateScope())
            await scope.ServiceProvider.GetRequiredService<LedgerDbContext>().ReceiptScans.Where(x => x.Id == first)
                .ExecuteUpdateAsync(u => u.SetProperty(x => x.BlobDeletedAt, (DateTimeOffset?)null), Ct);

        await RunAtAsync(TimeSpan.Zero);

        Assert.False(await BlobExistsAsync(s.Id, first));
        using var check = factory.Services.CreateScope();
        var scan = await check.ServiceProvider.GetRequiredService<LedgerDbContext>().ReceiptScans.SingleAsync(x => x.Id == first, Ct);
        Assert.Equal("replaced", scan.Status);
        Assert.NotNull(scan.BlobDeletedAt);
    }

    [Fact]
    public async Task Abandoned_upload_is_removed_after_a_day()
    {
        var (host, g, s) = await TableAsync();
        var start = await host.StartScanAsync(g.Id, s.Id);
        await ScanData.UploadAsync(start.UploadUrl, ScanData.Jpeg); // uploaded, never confirmed

        await RunAtAsync(TimeSpan.FromHours(23));
        Assert.True(await BlobExistsAsync(s.Id, start.ScanId));

        await RunAtAsync(TimeSpan.FromHours(25));
        Assert.False(await BlobExistsAsync(s.Id, start.ScanId));
        using var scope = factory.Services.CreateScope();
        Assert.False(await scope.ServiceProvider.GetRequiredService<LedgerDbContext>().ReceiptScans.AnyAsync(x => x.Id == start.ScanId, Ct));
    }
}
