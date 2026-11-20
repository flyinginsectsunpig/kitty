using Google.Protobuf.WellKnownTypes;
using Kitty.Contracts.Events.V1;
using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Features.Groups;
using Kitty.Ledger.Features.Table;
using Kitty.Ledger.Infrastructure;
using Kitty.Ledger.Infrastructure.Blob;
using Kitty.Ledger.Infrastructure.Errors;
using Kitty.Ledger.Infrastructure.Messaging;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Scans;

/// <summary>
/// Receipt photos for a table: the host asks for an upload URL, the browser uploads straight to blob storage,
/// and confirming the upload hands the photo to the ai service (via the outbox). Host only; open bills only.
/// </summary>
public static class ScanEndpoints
{
    public static readonly HashSet<string> PhotoTypes = ["image/jpeg", "image/png", "image/webp"];

    public static void MapScans(this RouteGroupBuilder sessions)
    {
        sessions.MapPost("/{sessionId:guid}/scans", StartAsync).WithName("StartReceiptScan").Produces<StartScanResultDto>(StatusCodes.Status201Created);
        sessions.MapPost("/{sessionId:guid}/scans/{scanId:guid}/uploaded", ConfirmUploadAsync).WithName("ConfirmReceiptUpload").Produces<TableSessionDto>();
    }

    private static async Task<IResult> StartAsync(Guid groupId, Guid sessionId, StartScanDto body, HttpContext http, LedgerDbContext db,
        ReceiptBlobs blobs, TimeProvider clock, CancellationToken ct)
    {
        if (await HostCheckAsync(db, groupId, sessionId, http, ct) is { } denied) return denied;
        if (body.Id == Guid.Empty) return ApiError.Validation("id must be a client-generated UUID.");
        if (!PhotoTypes.Contains(body.ContentType ?? "")) return ApiError.BadRequest(ErrorCodes.UploadNotImage, "Upload a JPEG, PNG or WebP photo.");
        var status = await TableEndpoints.CurrentStatusAsync(db, sessionId, ct);
        if (status != SessionStatus.Open) return TableEndpoints.WrongState(status);
        if (await db.ReceiptScans.AnyAsync(s => s.Id == body.Id, ct)) return ApiError.Conflict(ErrorCodes.AlreadyExists);

        await blobs.EnsureContainerAsync(ct);
        var scan = new ReceiptScan
        {
            Id = body.Id, SessionId = sessionId, BlobName = $"{sessionId}/{body.Id}", ContentType = body.ContentType!,
            Status = ScanStatus.AwaitingUpload, CreatedAt = clock.NowMicros(),
        };
        db.ReceiptScans.Add(scan);
        await db.SaveChangesAsync(ct);
        var (url, expiresAt) = blobs.IssueUpload(scan.BlobName);
        return Results.Created($"/groups/{groupId}/table-sessions/{sessionId}/scans/{scan.Id}",
            new StartScanResultDto(scan.Id, url, expiresAt, ReceiptBlobs.MaxBytes));
    }

    private static async Task<IResult> ConfirmUploadAsync(Guid groupId, Guid sessionId, Guid scanId, HttpContext http, LedgerDbContext db,
        ReceiptBlobs blobs, Outbox outbox, TableSessionService svc, TimeProvider clock, CancellationToken ct)
    {
        if (await HostCheckAsync(db, groupId, sessionId, http, ct) is { } denied) return denied;
        var scan = await db.ReceiptScans.SingleOrDefaultAsync(s => s.Id == scanId && s.SessionId == sessionId, ct);
        if (scan is null) return ApiError.NotFound();
        if (scan.Status != ScanStatus.AwaitingUpload) return await CurrentAsync(svc, groupId, sessionId, http, ct); // already confirmed

        var check = await blobs.InspectAsync(scan.BlobName, ct);
        if (check is null) return ApiError.BadRequest(ErrorCodes.UploadMissing, "The photo hasn't arrived yet.");
        var rejection = check.Size > ReceiptBlobs.MaxBytes
            ? ApiError.BadRequest(ErrorCodes.UploadTooLarge, "Photos can be up to 10 MB.")
            : !ReceiptBlobs.LooksLikePhoto(check.Head) ? ApiError.BadRequest(ErrorCodes.UploadNotImage, "That file isn't a JPEG, PNG or WebP photo.") : null;
        if (rejection is not null)
        {
            await blobs.DeleteAsync(scan.BlobName, ct);
            db.ReceiptScans.Remove(scan);
            await db.SaveChangesAsync(ct);
            return rejection;
        }

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        if (!await TableEndpoints.BumpAsync(db, sessionId, clock, ct, SessionStatus.Open))
            return TableEndpoints.WrongState(await TableEndpoints.CurrentStatusAsync(db, sessionId, ct));
        var session = await db.ReceiptSessions.AsNoTracking().SingleAsync(s => s.Id == sessionId, ct);

        var now = clock.NowMicros();
        var replaced = await db.ReceiptScans
            .Where(s => s.SessionId == sessionId && s.Id != scanId && s.BlobDeletedAt == null && s.Status != ScanStatus.AwaitingUpload)
            .ToListAsync(ct);
        foreach (var old in replaced)
        {
            if (old.Status == ScanStatus.Parsing) old.Status = ScanStatus.Replaced;
            old.BlobDeletedAt = now;
        }
        scan.Status = ScanStatus.Parsing;
        scan.UploadedAt = now;
        outbox.Add(Topics.ReceiptUploaded, sessionId.ToString(), new ReceiptUploaded
        {
            EventId = Guid.NewGuid().ToString(),
            OccurredAt = Timestamp.FromDateTimeOffset(now),
            ScanId = scan.Id.ToString(),
            SessionId = sessionId.ToString(),
            GroupId = groupId.ToString(),
            BlobName = scan.BlobName,
            Currency = session.Currency.Trim(),
            ContentType = scan.ContentType,
            Attempt = 0,
        });
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);

        foreach (var old in replaced) await blobs.DeleteAsync(old.BlobName, ct);
        await svc.NotifyAsync(sessionId, ct);
        return await CurrentAsync(svc, groupId, sessionId, http, ct);
    }

    /// <summary>Null when the caller is this table's host; otherwise the response to send (404 for no such table).</summary>
    internal static async Task<IResult?> HostCheckAsync(LedgerDbContext db, Guid groupId, Guid sessionId, HttpContext http, CancellationToken ct)
    {
        var host = await TableEndpoints.HostOfAsync(db, groupId, sessionId, ct);
        if (host is null) return ApiError.NotFound();
        return host == GroupMemberFilter.CallerMember(http).User.Id ? null : TableEndpoints.HostOnly();
    }

    internal static async Task<IResult> CurrentAsync(TableSessionService svc, Guid groupId, Guid sessionId, HttpContext http, CancellationToken ct) =>
        Results.Ok(await svc.ToDtoAsync((await svc.LoadAsync(groupId, sessionId, ct))!, TableEndpoints.Viewer(http), ct));
}
