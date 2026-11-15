using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Kitty.Ledger.Infrastructure.Auth;

public interface ICurrentUser
{
    /// <summary>The caller's User row, created from the token's claims on first sight.</summary>
    Task<User> GetAsync(CancellationToken ct);
}

public sealed class CurrentUser(IHttpContextAccessor http, LedgerDbContext db) : ICurrentUser
{
    private User? _cached;

    public async Task<User> GetAsync(CancellationToken ct)
    {
        if (_cached is not null) return _cached;

        var principal = http.HttpContext?.User ?? throw new InvalidOperationException("No HTTP context.");
        var sub = principal.FindFirst("sub")?.Value
            ?? throw new InvalidOperationException("Authenticated token has no 'sub' claim.");

        var existing = await db.Users.SingleOrDefaultAsync(u => u.KeycloakSub == sub, ct);
        if (existing is not null) return _cached = existing;

        var name = principal.FindFirst("name")?.Value ?? principal.FindFirst("preferred_username")?.Value ?? "Kitty user";
        var user = new User
        {
            Id = Guid.NewGuid(),
            KeycloakSub = sub,
            DisplayName = name.Length > 100 ? name[..100] : name,
            Email = principal.FindFirst("email")?.Value,
        };
        db.Users.Add(user);

        try
        {
            await db.SaveChangesAsync(ct);
            return _cached = user;
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            // Two first requests raced; the other one created the row.
            db.Entry(user).State = EntityState.Detached;
            return _cached = await db.Users.SingleAsync(u => u.KeycloakSub == sub, ct);
        }
    }
}
