using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Azure.Storage.Blobs;
using Kitty.Contracts.Events.V1;
using Kitty.Ledger.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Kitty.Ledger.IntegrationTests;

public sealed record ScanItemDto(Guid Id, string Description, int Quantity, long LineTotalMinor);
public sealed record ScanChargeDto(Guid Id, string Kind, long AmountMinor);
public sealed record TableScanDto(Guid Id, string Status, string? FailureReason, List<ScanItemDto>? SuggestedItems, List<ScanChargeDto>? SuggestedCharges);
public sealed record SessionWithScanDto(Guid Id, int Version, string Status, List<TableItemDto> Items, List<TableChargeDto> Charges, TableScanDto? Scan);
public sealed record StartScanDto(Guid ScanId, Uri UploadUrl, DateTimeOffset ExpiresAt, long MaxBytes);

public static class ScanData
{
    public static readonly byte[] Jpeg = [0xFF, 0xD8, 0xFF, 0xE0, .. new byte[64]];
    public static readonly byte[] Text = "this is not a photo of a receipt"u8.ToArray();

    public static async Task<StartScanDto> StartScanAsync(this HttpClient host, Guid groupId, Guid sessionId, string contentType = "image/jpeg")
    {
        var r = await host.PostJsonAsync($"/groups/{groupId}/table-sessions/{sessionId}/scans", new { id = Guid.NewGuid(), contentType });
        r.EnsureSuccessStatusCode();
        return await r.ReadAsync<StartScanDto>();
    }

    /// <summary>What the browser does: PUT straight to the SAS URL.</summary>
    public static async Task UploadAsync(Uri sasUrl, byte[] content, string contentType = "image/jpeg")
    {
        using var http = new HttpClient();
        using var body = new ByteArrayContent(content);
        body.Headers.ContentType = new MediaTypeHeaderValue(contentType);
        using var request = new HttpRequestMessage(HttpMethod.Put, sasUrl) { Content = body };
        request.Headers.Add("x-ms-blob-type", "BlockBlob");
        (await http.SendAsync(request, TestContext.Current.CancellationToken)).EnsureSuccessStatusCode();
    }

    public static Task<HttpResponseMessage> ConfirmUploadAsync(this HttpClient host, Guid groupId, Guid sessionId, Guid scanId) =>
        host.PostJsonAsync($"/groups/{groupId}/table-sessions/{sessionId}/scans/{scanId}/uploaded", new { });

    public static async Task<(Guid ScanId, SessionWithScanDto Session)> ScanAsync(this HttpClient host, Guid groupId, Guid sessionId)
    {
        var start = await host.StartScanAsync(groupId, sessionId);
        await UploadAsync(start.UploadUrl, Jpeg);
        var r = await host.ConfirmUploadAsync(groupId, sessionId, start.ScanId);
        r.EnsureSuccessStatusCode();
        return (start.ScanId, await r.ReadAsync<SessionWithScanDto>());
    }
}

[Collection(ApiCollection.Name)]
public class ScanTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private async Task<(HttpClient Host, GroupDto Group, TableSessionDto Session)> TableAsync()
    {
        var host = factory.NewUser("Host");
        var g = await host.CreateGroupAsync();
        return (host, g, await host.CreateSessionAsync(g.Id, g.Members[0].Id));
    }

    private BlobContainerClient Receipts => new BlobServiceClient(factory.BlobConnectionString).GetBlobContainerClient("receipts");

    [Fact]
    public async Task Host_gets_upload_url_and_confirms_scan()
    {
        var (host, g, s) = await TableAsync();
        var start = await host.StartScanAsync(g.Id, s.Id);
        Assert.Equal(10_485_760, start.MaxBytes);
        Assert.True(start.ExpiresAt > DateTimeOffset.UtcNow.AddMinutes(9) && start.ExpiresAt <= DateTimeOffset.UtcNow.AddMinutes(10).AddSeconds(5));

        await ScanData.UploadAsync(start.UploadUrl, ScanData.Jpeg);
        var r = await host.ConfirmUploadAsync(g.Id, s.Id, start.ScanId);

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var session = await r.ReadAsync<SessionWithScanDto>();
        Assert.Equal((start.ScanId, "parsing"), (session.Scan!.Id, session.Scan.Status));
        Assert.Equal(s.Version + 1, session.Version);

        var uploaded = await UploadedEventsAsync(start.ScanId);
        var e = Assert.Single(uploaded);
        Assert.Equal((s.Id.ToString(), g.Id.ToString(), $"{s.Id}/{start.ScanId}", "ZAR", "image/jpeg", 0),
            (e.SessionId, e.GroupId, e.BlobName, e.Currency, e.ContentType, e.Attempt));
    }

    [Fact]
    public async Task Upload_that_is_not_an_image_is_rejected_and_deleted()
    {
        var (host, g, s) = await TableAsync();
        var start = await host.StartScanAsync(g.Id, s.Id);
        await ScanData.UploadAsync(start.UploadUrl, ScanData.Text);

        var r = await host.ConfirmUploadAsync(g.Id, s.Id, start.ScanId);

        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal("upload_not_image", await r.ReadCodeAsync());
        Assert.False(await Receipts.GetBlobClient($"{s.Id}/{start.ScanId}").ExistsAsync(Ct));
        Assert.Empty(await UploadedEventsAsync(start.ScanId));
    }

    [Fact]
    public async Task Oversized_upload_is_rejected()
    {
        var (host, g, s) = await TableAsync();
        var start = await host.StartScanAsync(g.Id, s.Id);
        await ScanData.UploadAsync(start.UploadUrl, [.. ScanData.Jpeg, .. new byte[10_485_761 - ScanData.Jpeg.Length]]);

        var r = await host.ConfirmUploadAsync(g.Id, s.Id, start.ScanId);

        Assert.Equal("upload_too_large", await r.ReadCodeAsync());
        Assert.False(await Receipts.GetBlobClient($"{s.Id}/{start.ScanId}").ExistsAsync(Ct));
    }

    [Fact]
    public async Task Confirm_without_upload_returns_upload_missing()
    {
        var (host, g, s) = await TableAsync();
        var start = await host.StartScanAsync(g.Id, s.Id);
        Assert.Equal("upload_missing", await (await host.ConfirmUploadAsync(g.Id, s.Id, start.ScanId)).ReadCodeAsync());
    }

    [Fact]
    public async Task Only_the_host_can_scan()
    {
        var (host, g, s) = await TableAsync();
        var friend = factory.NewUser("Friend");
        await friend.JoinAsync(host, g.Id);
        var url = $"/groups/{g.Id}/table-sessions/{s.Id}/scans";

        Assert.Equal("host_only", await (await friend.PostJsonAsync(url, new { id = Guid.NewGuid(), contentType = "image/jpeg" })).ReadCodeAsync());
        Assert.Equal(HttpStatusCode.NotFound,
            (await factory.NewUser("Eve").PostJsonAsync(url, new { id = Guid.NewGuid(), contentType = "image/jpeg" })).StatusCode);
    }

    [Fact]
    public async Task Only_photos_can_be_scanned()
    {
        var (host, g, s) = await TableAsync();
        var r = await host.PostJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/scans", new { id = Guid.NewGuid(), contentType = "application/pdf" });
        Assert.Equal("upload_not_image", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Scan_on_locked_session_returns_409()
    {
        var (host, g, s) = await TableAsync();
        (await host.PostJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/lock", new { })).EnsureSuccessStatusCode();
        var r = await host.PostJsonAsync($"/groups/{g.Id}/table-sessions/{s.Id}/scans", new { id = Guid.NewGuid(), contentType = "image/jpeg" });
        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.Equal("session_locked", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task New_scan_replaces_the_old_one_and_deletes_its_blob()
    {
        var (host, g, s) = await TableAsync();
        var (first, _) = await host.ScanAsync(g.Id, s.Id);
        var (second, session) = await host.ScanAsync(g.Id, s.Id);

        Assert.Equal(second, session.Scan!.Id);
        Assert.False(await Receipts.GetBlobClient($"{s.Id}/{first}").ExistsAsync(Ct));
        Assert.True(await Receipts.GetBlobClient($"{s.Id}/{second}").ExistsAsync(Ct));
    }

    private async Task<List<ReceiptUploaded>> UploadedEventsAsync(Guid scanId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<LedgerDbContext>();
        var rows = await db.OutboxMessages.Where(m => m.Topic == "receipt.uploaded").Select(m => m.Payload).ToListAsync(Ct);
        return rows.Select(p => ReceiptUploaded.Parser.ParseFrom(p)).Where(e => e.ScanId == scanId.ToString()).ToList();
    }
}
