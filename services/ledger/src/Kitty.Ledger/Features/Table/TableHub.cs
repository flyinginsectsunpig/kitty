using Kitty.Ledger.Data;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Table;

public sealed record SessionChanged(Guid SessionId, int Version);

/// <summary>
/// Live table updates. Connections join a session's group only after the same checks REST uses:
/// a member of the session's group (bearer token), or that session's guest (guest_token). Events carry only
/// the session id and version; clients re-fetch through REST, so authorization lives in one place.
/// </summary>
public sealed class TableHub(LedgerDbContext db, TimeProvider clock, ListenTokens listenTokens) : Hub
{
    public const string Path = "/hubs/table";
    public const string GuestTokenQuery = "guest_token";

    public static string GroupName(Guid sessionId) => $"table:{sessionId}";

    public async Task JoinSession(Guid sessionId)
    {
        var ct = Context.ConnectionAborted;
        var query = Context.GetHttpContext()?.Request.Query;
        var sub = Context.User?.FindFirst("sub")?.Value;
        var allowed = listenTokens.Allows(query?[ListenTokens.Query].ToString(), sessionId) || (sub is not null
            ? await db.ReceiptSessions.AnyAsync(s => s.Id == sessionId && db.Members.Any(m => m.GroupId == s.GroupId
                  && db.Users.Any(u => u.Id == m.UserId && u.KeycloakSub == sub)), ct)
            : await GuestTokens.ResolveAsync(db, query?[GuestTokenQuery].ToString(), sessionId,
                  clock.GetUtcNow(), ct) is not null);

        if (!allowed) throw new HubException("not_found");
        await Groups.AddToGroupAsync(Context.ConnectionId, GroupName(sessionId), ct);
    }

    public Task LeaveSession(Guid sessionId) => Groups.RemoveFromGroupAsync(Context.ConnectionId, GroupName(sessionId));
}

public sealed class SignalRTableNotifier(IHubContext<TableHub> hub) : ITableNotifier
{
    public Task NotifyAsync(Guid sessionId, int version, CancellationToken ct) =>
        hub.Clients.Group(TableHub.GroupName(sessionId)).SendAsync("SessionChanged", new SessionChanged(sessionId, version), ct);
}
