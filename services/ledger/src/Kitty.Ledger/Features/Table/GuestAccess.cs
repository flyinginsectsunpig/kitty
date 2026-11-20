using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Infrastructure.Errors;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Table;

/// <summary>Guest tokens: 32 random bytes shown once; only the SHA-256 hash is stored.</summary>
public static class GuestTokens
{
    public const string Scheme = "Guest";
    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(24);

    public static (string Token, string Hash) Create()
    {
        var token = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));
        return (token, Hash(token));
    }

    public static string Hash(string token) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    /// <summary>The token from "Authorization: Guest &lt;token&gt;", or null.</summary>
    public static string? FromHeader(HttpRequest request)
    {
        var header = request.Headers.Authorization.ToString();
        return header.StartsWith(Scheme + " ", StringComparison.Ordinal) ? header[(Scheme.Length + 1)..].Trim() : null;
    }

    /// <summary>
    /// The guest for this token, but only for this session, only before it expires, and only while the
    /// session is still open or locked (a confirmed or cancelled bill ends every guest's access).
    /// </summary>
    public static Task<Guest?> ResolveAsync(LedgerDbContext db, string? token, Guid sessionId, DateTimeOffset now, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 100) return Task.FromResult<Guest?>(null);
        var hash = Hash(token);
        return db.Guests.AsNoTracking()
            .Where(g => g.TokenHash == hash && g.SessionId == sessionId && g.ExpiresAt > now)
            .Where(g => db.ReceiptSessions.Any(s => s.Id == g.SessionId && (s.Status == SessionStatus.Open || s.Status == SessionStatus.Locked)))
            .SingleOrDefaultAsync(ct);
    }
}

/// <summary>Guards /guest/table-sessions/{sessionId}/…: any invalid token, wrong session or expiry is a plain 404.</summary>
public sealed class GuestFilter(LedgerDbContext db, TimeProvider clock) : IEndpointFilter
{
    private const string ItemKey = "kitty.guest";

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        if (!Guid.TryParse(http.Request.RouteValues["sessionId"]?.ToString(), out var sessionId)) return ApiError.NotFound();
        var guest = await GuestTokens.ResolveAsync(db, GuestTokens.FromHeader(http.Request), sessionId, clock.GetUtcNow(), http.RequestAborted);
        if (guest is null) return ApiError.NotFound();
        http.Items[ItemKey] = guest;
        return await next(context);
    }

    public static Guest CurrentGuest(HttpContext http) =>
        http.Items[ItemKey] as Guest ?? throw new InvalidOperationException("GuestFilter did not run.");
}
