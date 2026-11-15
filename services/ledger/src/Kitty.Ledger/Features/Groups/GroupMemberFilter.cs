using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Infrastructure.Auth;
using Kitty.Ledger.Infrastructure.Errors;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Groups;

/// <summary>
/// Guards every /groups/{groupId}/... route: callers who are not members get 404 (never 403),
/// so group ids cannot be probed. The caller's member row is available via <see cref="CallerMember"/>.
/// </summary>
public sealed class GroupMemberFilter(ICurrentUser currentUser, LedgerDbContext db) : IEndpointFilter
{
    private const string ItemKey = "kitty.callerMember";

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        if (!Guid.TryParse(http.Request.RouteValues["groupId"]?.ToString(), out var groupId))
            return ApiError.NotFound();

        var user = await currentUser.GetAsync(http.RequestAborted);
        var member = await db.Members.SingleOrDefaultAsync(m => m.GroupId == groupId && m.UserId == user.Id, http.RequestAborted);
        if (member is null) return ApiError.NotFound();

        http.Items[ItemKey] = new CallerContext(user, member);
        return await next(context);
    }

    public static CallerContext CallerMember(HttpContext http) =>
        http.Items[ItemKey] as CallerContext ?? throw new InvalidOperationException("GroupMemberFilter did not run.");
}

public sealed record CallerContext(User User, Member Member);
