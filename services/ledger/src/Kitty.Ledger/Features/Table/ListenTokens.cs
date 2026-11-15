using Kitty.Ledger.Features.Groups;
using Microsoft.AspNetCore.DataProtection;

namespace Kitty.Ledger.Features.Table;

public sealed record ListenTokenDto(string Token, DateTimeOffset ExpiresAt);

/// <summary>
/// Browser-safe, read-only hub access for one session: a signed, time-limited token that only lets a
/// connection join that session's "something changed" group. The web app trades a member's session (or a
/// guest's httpOnly cookie) for one, so browsers never hold a Keycloak access token or a guest token.
/// </summary>
public sealed class ListenTokens(IDataProtectionProvider provider, TimeProvider clock)
{
    public const string Query = "listen_token";
    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(12);

    private readonly ITimeLimitedDataProtector _protector =
        provider.CreateProtector("Kitty.Table.ListenToken.v1").ToTimeLimitedDataProtector();

    public ListenTokenDto Issue(Guid sessionId)
    {
        var expires = clock.GetUtcNow() + Lifetime;
        return new ListenTokenDto(_protector.Protect(sessionId.ToString("N"), expires), expires);
    }

    public bool Allows(string? token, Guid sessionId)
    {
        if (string.IsNullOrEmpty(token)) return false;
        try
        {
            return _protector.Unprotect(token, out _) == sessionId.ToString("N");
        }
        catch (System.Security.Cryptography.CryptographicException)
        {
            return false; // forged, tampered or expired
        }
    }

    public static void Map(RouteGroupBuilder group, RouteGroupBuilder guest)
    {
        group.MapGet("/table-sessions/{sessionId:guid}/listen-token", async (Guid groupId, Guid sessionId, TableSessionService svc,
                ListenTokens tokens, CancellationToken ct) =>
            await svc.LoadAsync(groupId, sessionId, ct) is null ? Infrastructure.Errors.ApiError.NotFound() : Results.Ok(tokens.Issue(sessionId)))
            .WithTags("Table").WithName("GetTableListenToken").Produces<ListenTokenDto>();

        guest.MapGet("/listen-token", (Guid sessionId, ListenTokens tokens) => Results.Ok(tokens.Issue(sessionId)))
            .WithName("GetTableListenTokenAsGuest").Produces<ListenTokenDto>();
    }
}
