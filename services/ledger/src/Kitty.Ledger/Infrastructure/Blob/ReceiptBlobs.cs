using Azure;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using Azure.Storage.Sas;

namespace Kitty.Ledger.Infrastructure.Blob;

/// <summary>Size, type and the first bytes of an uploaded blob — enough to tell whether it is really a photo.</summary>
public sealed record BlobCheck(long Size, string? ContentType, byte[] Head);

/// <summary>
/// The private "receipts" container. Browsers upload with a short-lived, write-only SAS URL; nobody gets read
/// access. When Blob:PublicUrl is set (deploy/compose: Caddy at /blob in front of Azurite) the SAS URL's host
/// is rewritten to it so the browser uploads same-origin.
/// </summary>
public sealed class ReceiptBlobs(BlobServiceClient service, IConfiguration config, TimeProvider clock)
{
    public const string ContainerName = "receipts";
    public const long MaxBytes = 10 * 1024 * 1024;
    public static readonly TimeSpan UploadWindow = TimeSpan.FromMinutes(10);

    private readonly BlobContainerClient _container = service.GetBlobContainerClient(ContainerName);
    private readonly Uri? _publicUrl = config["Blob:PublicUrl"] is { Length: > 0 } url ? new Uri(url.TrimEnd('/') + "/") : null;

    private volatile bool _containerReady;

    /// <summary>Creates the container on first use; later calls return straight away.</summary>
    public async Task EnsureContainerAsync(CancellationToken ct)
    {
        if (_containerReady) return;
        await _container.CreateIfNotExistsAsync(PublicAccessType.None, cancellationToken: ct);
        _containerReady = true;
    }

    public (Uri UploadUrl, DateTimeOffset ExpiresAt) IssueUpload(string blobName)
    {
        var expiresAt = clock.GetUtcNow() + UploadWindow;
        var sas = _container.GetBlobClient(blobName).GenerateSasUri(BlobSasPermissions.Create | BlobSasPermissions.Write, expiresAt);
        var url = _publicUrl is null ? sas : new Uri(_publicUrl, sas.PathAndQuery.TrimStart('/'));
        return (url, expiresAt);
    }

    /// <summary>Null when nothing was uploaded.</summary>
    public async Task<BlobCheck?> InspectAsync(string blobName, CancellationToken ct)
    {
        var blob = _container.GetBlobClient(blobName);
        try
        {
            var props = (await blob.GetPropertiesAsync(cancellationToken: ct)).Value;
            var head = (await blob.DownloadContentAsync(new BlobDownloadOptions { Range = new HttpRange(0, 16) }, ct)).Value.Content.ToArray();
            return new BlobCheck(props.ContentLength, props.ContentType, head);
        }
        catch (RequestFailedException e) when (e.Status == 404)
        {
            return null;
        }
    }

    public async Task DeleteAsync(string blobName, CancellationToken ct) =>
        await _container.GetBlobClient(blobName).DeleteIfExistsAsync(DeleteSnapshotsOption.IncludeSnapshots, cancellationToken: ct);

    /// <summary>Local dev only: the browser (web on another port) uploads to Azurite cross-origin.</summary>
    public async Task ConfigureCorsAsync(IEnumerable<string> origins, CancellationToken ct)
    {
        var props = (await service.GetPropertiesAsync(ct)).Value;
        props.Cors = [new BlobCorsRule
        {
            AllowedOrigins = string.Join(',', origins), AllowedMethods = "PUT", AllowedHeaders = "*",
            ExposedHeaders = "*", MaxAgeInSeconds = 3600,
        }];
        await service.SetPropertiesAsync(props, ct);
    }

    /// <summary>JPEG, PNG or WebP, judged by the file's own first bytes rather than what the client claims.</summary>
    public static bool LooksLikePhoto(ReadOnlySpan<byte> head) =>
        head.StartsWith((ReadOnlySpan<byte>)[0xFF, 0xD8, 0xFF])
        || head.StartsWith((ReadOnlySpan<byte>)[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        || (head.Length >= 12 && head[..4].SequenceEqual("RIFF"u8) && head[8..12].SequenceEqual("WEBP"u8));
}

/// <summary>Creates the container (and, in local dev, the CORS rule) once the app starts; retries until storage is up.</summary>
public sealed class ReceiptBlobsSetup(ReceiptBlobs blobs, IConfiguration config, ILogger<ReceiptBlobsSetup> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                await blobs.EnsureContainerAsync(stoppingToken);
                if (config.GetValue<bool>("Blob:ConfigureCors"))
                    await blobs.ConfigureCorsAsync(
                        config["Ledger:WebOrigins"]?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries) ?? [],
                        stoppingToken);
                return;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                log.LogWarning(ex, "Blob storage is not ready yet; retrying");
                await Task.Delay(TimeSpan.FromSeconds(Math.Min(30, 1 << Math.Min(attempt, 5))), stoppingToken);
            }
        }
    }
}
