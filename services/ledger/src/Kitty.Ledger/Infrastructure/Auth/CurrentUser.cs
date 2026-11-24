using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Features.Notifications;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Kitty.Ledger.Infrastructure.Auth;

public interface ICurrentUser
{
    /// <summary>The caller's User row, created from the token's claims on first sight.</summary>
    Task<User> GetAsync(CancellationToken ct);
}

/// <summary>
/// The caller's User row. Created on first sight; the email and whether Keycloak verified it are refreshed from the
/// token whenever they change, and the person's notification delivery state is republished for pulse when they do.
/// </summary>
public sealed class CurrentUser(IHttpContextAccessor http, LedgerDbContext db, NotifySettingsPublisher notify) : ICurrentUser
{
    private User? _cached;

    public async Task<User> GetAsync(CancellationToken ct)
    {
        if (_cached is not null) return _cached;

        var principal = http.HttpContext?.User ?? throw new InvalidOperationException("No HTTP context.");
        var sub = principal.FindFirst("sub")?.Value
            ?? throw new InvalidOperationException("Authenticated token has no 'sub' claim.");
        var email = principal.FindFirst("email")?.Value;
        var verified = string.Equals(principal.FindFirst("email_verified")?.Value, "true", StringComparison.OrdinalIgnoreCase);

        var existing = await db.Users.SingleOrDefaultAsync(u => u.KeycloakSub == sub, ct);
        if (existing is not null)
        {
            if (existing.Email != email || existing.EmailVerified != verified)
            {
                (existing.Email, existing.EmailVerified) = (email, verified);
                await notify.QueueAsync(existing, ct);
                await db.SaveChangesAsync(ct);
            }
            return _cached = existing;
        }

        var name = principal.FindFirst("name")?.Value ?? principal.FindFirst("preferred_username")?.Value ?? "Kitty user";
        var user = new User
        {
            Id = Guid.NewGuid(),
            KeycloakSub = sub,
            DisplayName = name.Length > 100 ? name[..100] : name,
            Email = email,
            EmailVerified = verified,
        };
        db.Users.Add(user);
        await notify.QueueAsync(user, ct); // pulse needs everyone's (default) settings to deliver anything

        try
        {
            await db.SaveChangesAsync(ct);
            return _cached = user;
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            // Two first requests raced; the other one created the row (and published its settings).
            db.ChangeTracker.Clear();
            return _cached = await db.Users.SingleAsync(u => u.KeycloakSub == sub, ct);
        }
    }
}
