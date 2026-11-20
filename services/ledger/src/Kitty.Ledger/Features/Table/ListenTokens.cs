using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Features.Groups;
using Kitty.Ledger.Infrastructure.Errors;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Table;

public sealed record ListenTokenDto(string Token, DateTimeOffset ExpiresAt);

/// <summary>
/// Browser-safe, read-only hub access for one session: a signed, time-limited token naming the session and
/// who it was issued to. The web app trades a member's session (or a guest's httpOnly cookie) for one, so
/// browsers never hold a Keycloak access token or a guest token. Joining re-checks that the person still
/// has access, so the token never outlives membership or a guest's access.
/// </summary>
public sealed class ListenTokens(IDataProtectionProvider provider, TimeProvider clock, IServiceScopeFactory scopes)
{
    public const string Query = "listen_token";
    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(12);
    private const string MemberPrefix = "m";
    private const string GuestPrefix = "g";

    private readonly ITimeLimitedDataProtector _protector =
        provider.CreateProtector("Kitty.Table.ListenToken.v2").ToTimeLimitedDataProtector();

    public ListenTokenDto IssueForMember(Guid sessionId, Guid userId) => Issue(sessionId, MemberPrefix, userId, clock.GetUtcNow() + Lifetime);

    public ListenTokenDto IssueForGuest(Guid sessionId, Guest guest)
    {
        var expires = clock.GetUtcNow() + Lifetime;
        return Issue(sessionId, GuestPrefix, guest.Id, guest.ExpiresAt < expires ? guest.ExpiresAt : expires);
    }

    private ListenTokenDto Issue(Guid sessionId, string kind, Guid principal, DateTimeOffset expires) =>
        new(_protector.Protect($"{sessionId:N}|{kind}|{principal:N}", expires), expires);

    public async Task<bool> AllowsAsync(string? token, Guid sessionId, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(token)) return false;
        string payload;
        try
        {
            payload = _protector.Unprotect(token, out _);
        }
        catch (System.Security.Cryptography.CryptographicException)
        {
            return false; // forged, tampered or expired
        }

        var parts = payload.Split('|');
        if (parts.Length != 3 || parts[0] != sessionId.ToString("N") || !Guid.TryParse(parts[2], out var principal)) return false;

        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<LedgerDbContext>();
        return parts[1] switch
        {
            MemberPrefix => await db.ReceiptSessions.AnyAsync(s => s.Id == sessionId
                && db.Members.Any(m => m.GroupId == s.GroupId && m.UserId == principal), ct),
            GuestPrefix => await db.Guests.AnyAsync(g => g.Id == principal && g.SessionId == sessionId && g.ExpiresAt > clock.GetUtcNow()
                && db.ReceiptSessions.Any(s => s.Id == sessionId && (s.Status == SessionStatus.Open || s.Status == SessionStatus.Locked)), ct),
            _ => false,
        };
    }

    public static void Map(RouteGroupBuilder group, RouteGroupBuilder guest)
    {
        group.MapGet("/table-sessions/{sessionId:guid}/listen-token", async (Guid groupId, Guid sessionId, HttpContext http,
                TableSessionService svc, ListenTokens tokens, CancellationToken ct) =>
            await svc.LoadAsync(groupId, sessionId, ct) is null
                ? ApiError.NotFound()
                : Results.Ok(tokens.IssueForMember(sessionId, GroupMemberFilter.CallerMember(http).User.Id)))
            .WithTags("Table").WithName("GetTableListenToken").Produces<ListenTokenDto>();

        guest.MapGet("/listen-token", (Guid sessionId, HttpContext http, ListenTokens tokens) =>
                Results.Ok(tokens.IssueForGuest(sessionId, GuestFilter.CurrentGuest(http))))
            .WithName("GetTableListenTokenAsGuest").Produces<ListenTokenDto>();
    }
}
