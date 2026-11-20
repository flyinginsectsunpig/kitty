using System.Security.Cryptography;
using System.Text;
using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Infrastructure.Auth;
using Kitty.Ledger.Infrastructure.Errors;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Kitty.Ledger.Infrastructure.Idempotency;

/// <summary>
/// Every POST/PUT/PATCH/DELETE must carry an Idempotency-Key. The first request with a key runs;
/// repeats with the same body get the stored response; repeats with a different body get 422;
/// a repeat while the first is still running gets 409. 5xx responses are not stored, so clients can retry.
/// Keys are scoped per user and kept for 24 hours.
/// </summary>
public sealed class IdempotencyMiddleware(RequestDelegate next)
{
    public const string HeaderName = "Idempotency-Key";
    private const string InProgress = "in_progress";
    private const string Done = "done";

    public async Task InvokeAsync(HttpContext context, ICurrentUser currentUser, IServiceScopeFactory scopes, TimeProvider clock)
    {
        // SignalR's negotiate/long-poll POSTs are transport, not business writes.
        if (!IsMutating(context.Request.Method) || context.User.Identity?.IsAuthenticated != true
            || context.Request.Path.StartsWithSegments("/hubs"))
        {
            await next(context);
            return;
        }

        var key = context.Request.Headers[HeaderName].ToString();
        if (key.Length is < 1 or > 255)
        {
            await ApiError.BadRequest(ErrorCodes.IdempotencyKeyRequired, $"Send a unique {HeaderName} header (1–255 chars).")
                .ExecuteAsync(context);
            return;
        }

        var ct = context.RequestAborted;
        var user = await currentUser.GetAsync(ct);
        var hash = await HashRequestAsync(context.Request, ct);

        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<LedgerDbContext>();

        var claimed = await TryClaimAsync(db, new IdempotencyRecord
        {
            UserId = user.Id, Key = key, RequestHash = hash, Status = InProgress, CreatedAt = clock.GetUtcNow(),
        }, ct);

        if (!claimed)
        {
            await RespondToRepeatAsync(context, db, user.Id, key, hash, ct);
            return;
        }

        var originalBody = context.Response.Body;
        await using var buffer = new MemoryStream();
        context.Response.Body = buffer;
        try
        {
            await next(context);
        }
        catch
        {
            // Unhandled failure: release the key so the client can retry instead of getting 409 for a day.
            await db.IdempotencyRecords.Where(r => r.UserId == user.Id && r.Key == key)
                .ExecuteDeleteAsync(CancellationToken.None);
            throw;
        }
        finally
        {
            context.Response.Body = originalBody;
        }

        var record = await db.IdempotencyRecords.SingleAsync(r => r.UserId == user.Id && r.Key == key, CancellationToken.None);
        if (context.Response.StatusCode >= 500)
        {
            db.IdempotencyRecords.Remove(record);
        }
        else
        {
            record.Status = Done;
            record.StatusCode = context.Response.StatusCode;
            record.ResponseBody = buffer.Length == 0 ? null : Encoding.UTF8.GetString(buffer.ToArray());
        }
        await db.SaveChangesAsync(CancellationToken.None);

        buffer.Position = 0;
        await buffer.CopyToAsync(originalBody, ct);
    }

    private static bool IsMutating(string method) =>
        HttpMethods.IsPost(method) || HttpMethods.IsPut(method) || HttpMethods.IsPatch(method) || HttpMethods.IsDelete(method);

    private static async Task<string> HashRequestAsync(HttpRequest request, CancellationToken ct)
    {
        request.EnableBuffering();
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        sha.AppendData(Encoding.UTF8.GetBytes($"{request.Method}\n{request.Path}{request.QueryString}\n"));
        var chunk = new byte[8192];
        int read;
        while ((read = await request.Body.ReadAsync(chunk, ct)) > 0) sha.AppendData(chunk, 0, read);
        request.Body.Position = 0;
        return Convert.ToHexStringLower(sha.GetHashAndReset());
    }

    private static async Task<bool> TryClaimAsync(LedgerDbContext db, IdempotencyRecord record, CancellationToken ct)
    {
        db.IdempotencyRecords.Add(record);
        try
        {
            await db.SaveChangesAsync(ct);
            return true;
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            db.Entry(record).State = EntityState.Detached;
            return false;
        }
    }

    private static async Task RespondToRepeatAsync(HttpContext context, LedgerDbContext db, Guid userId, string key,
        string hash, CancellationToken ct)
    {
        var existing = await db.IdempotencyRecords.AsNoTracking().SingleAsync(r => r.UserId == userId && r.Key == key, ct);

        if (existing.RequestHash != hash)
        {
            await ApiError.Problem(StatusCodes.Status422UnprocessableEntity, ErrorCodes.IdempotencyKeyReused,
                "This Idempotency-Key was already used for a different request.").ExecuteAsync(context);
            return;
        }

        if (existing.Status != Done)
        {
            await ApiError.Conflict(ErrorCodes.RequestInProgress, "The original request is still being processed.")
                .ExecuteAsync(context);
            return;
        }

        context.Response.StatusCode = existing.StatusCode!.Value;
        context.Response.Headers["Idempotent-Replayed"] = "true";
        if (existing.ResponseBody is not null)
        {
            context.Response.ContentType = existing.StatusCode >= 400 ? "application/problem+json" : "application/json; charset=utf-8";
            await context.Response.WriteAsync(existing.ResponseBody, ct);
        }
    }
}
