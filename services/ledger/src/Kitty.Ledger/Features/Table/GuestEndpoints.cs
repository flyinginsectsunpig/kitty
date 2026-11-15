using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Infrastructure;
using Kitty.Ledger.Infrastructure.Errors;
using Kitty.Ledger.Infrastructure.RateLimiting;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Table;

public sealed record JoinTableDto(string DisplayName);
public sealed record GuestJoinDto(Guid GuestId, string GuestToken, DateTimeOffset ExpiresAt);

/// <summary>
/// People at the table without an account. They reach exactly one session through these anonymous routes;
/// nothing under /groups accepts a guest token.
/// </summary>
public static class GuestEndpoints
{
    public const int MaxGuestsPerSession = 30;

    public static void MapGuestTable(this IEndpointRouteBuilder app)
    {
        app.MapPost("/table-sessions/{sessionId:guid}/join", JoinAsync)
            .AllowAnonymous().RequireRateLimiting(WriteRateLimiting.GuestJoinPolicy)
            .WithTags("Guests").WithName("JoinTableAsGuest").Produces<GuestJoinDto>(StatusCodes.Status201Created);

        var guest = app.MapGroup("/guest/table-sessions/{sessionId:guid}")
            .AllowAnonymous().AddEndpointFilter<GuestFilter>().WithTags("Guests");
        guest.MapGet("/", GetAsync).WithName("GetTableAsGuest").Produces<TableSessionDto>();
        guest.MapPut("/items/{itemId:guid}/claim", (Guid sessionId, Guid itemId, HttpContext http, TableSessionService svc, CancellationToken ct) =>
            ClaimAsync(sessionId, itemId, true, http, svc, ct)).WithName("ClaimTableItemAsGuest");
        guest.MapDelete("/items/{itemId:guid}/claim", (Guid sessionId, Guid itemId, HttpContext http, TableSessionService svc, CancellationToken ct) =>
            ClaimAsync(sessionId, itemId, false, http, svc, ct)).WithName("UnclaimTableItemAsGuest");
    }

    private static async Task<IResult> JoinAsync(Guid sessionId, JoinTableDto body, LedgerDbContext db, TableSessionService svc,
        TimeProvider clock, CancellationToken ct)
    {
        var name = body.DisplayName?.Trim() ?? "";
        if (name.Length is < 1 or > 40) return ApiError.Validation("displayName must be 1–40 characters.");

        var session = await db.ReceiptSessions.Include(s => s.Guests).SingleOrDefaultAsync(s => s.Id == sessionId, ct);
        if (session is null) return ApiError.NotFound();
        if (session.Status == SessionStatus.Locked) return TableEndpoints.SessionLocked();
        if (session.Status != SessionStatus.Open) return TableEndpoints.SessionClosed();
        if (session.Guests.Count >= MaxGuestsPerSession) return ApiError.Validation("This table is full.");

        var (token, hash) = GuestTokens.Create();
        var guest = new Guest
        {
            Id = Guid.NewGuid(), SessionId = sessionId, DisplayName = name, TokenHash = hash,
            ExpiresAt = clock.GetUtcNow() + GuestTokens.Lifetime,
        };
        session.Guests.Add(guest);
        session.Version++;
        session.UpdatedAt = clock.NowMicros();
        await db.SaveChangesAsync(ct);
        await svc.NotifyAsync(sessionId, ct);
        return Results.Created($"/guest/table-sessions/{sessionId}", new GuestJoinDto(guest.Id, token, guest.ExpiresAt));
    }

    private static async Task<IResult> GetAsync(Guid sessionId, HttpContext http, TableSessionService svc, CancellationToken ct)
    {
        var session = await svc.LoadByIdAsync(sessionId, ct);
        return session is null ? ApiError.NotFound() : Results.Ok(await svc.ToDtoAsync(session, ct));
    }

    private static async Task<IResult> ClaimAsync(Guid sessionId, Guid itemId, bool claimed, HttpContext http, TableSessionService svc,
        CancellationToken ct)
    {
        var guest = GuestFilter.CurrentGuest(http);
        return await svc.SetClaimAsync(sessionId, itemId, ClaimantKinds.Guest, guest.Id, claimed, ct) switch
        {
            ChangeOutcome.Ok => Results.NoContent(),
            ChangeOutcome.Locked => TableEndpoints.SessionLocked(),
            ChangeOutcome.Closed => TableEndpoints.SessionClosed(),
            _ => ApiError.NotFound(),
        };
    }
}
