using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Domain;
using Kitty.Ledger.Infrastructure.Audit;
using Kitty.Ledger.Infrastructure.Auth;
using Kitty.Ledger.Infrastructure.Errors;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Groups;

public static class GroupEndpoints
{
    public const string EntityType = "group";

    /// <summary>Maps /groups and returns the member-guarded /groups/{groupId} route group for other features.</summary>
    public static RouteGroupBuilder MapGroups(this IEndpointRouteBuilder app)
    {
        var groups = app.MapGroup("/groups").WithTags("Groups");

        groups.MapPost("/", CreateAsync).WithName("CreateGroup").Produces<GroupDto>(StatusCodes.Status201Created);
        groups.MapGet("/", ListAsync).WithName("ListGroups").Produces<IReadOnlyList<GroupSummaryDto>>();

        var group = groups.MapGroup("/{groupId:guid}").AddEndpointFilter<GroupMemberFilter>();
        group.MapGet("/", GetAsync).WithName("GetGroup").Produces<GroupDto>();
        group.MapPatch("/", UpdateAsync).WithName("UpdateGroup").Produces<GroupDto>();
        return group;
    }

    private static async Task<IResult> CreateAsync(CreateGroupDto body, ICurrentUser currentUser, LedgerDbContext db,
        AuditWriter audit, TimeProvider clock, CancellationToken ct)
    {
        var name = body.Name?.Trim() ?? "";
        if (body.Id == Guid.Empty) return ApiError.Validation("id must be a client-generated UUID.");
        if (name.Length is < 1 or > 60) return ApiError.Validation("name must be 1–60 characters.");
        if (!Currencies.IsSupported(body.BaseCurrency ?? ""))
            return ApiError.BadRequest(ErrorCodes.CurrencyUnsupported, $"'{body.BaseCurrency}' is not a supported currency.");
        if (await db.Groups.AnyAsync(g => g.Id == body.Id, ct)) return ApiError.Conflict(ErrorCodes.AlreadyExists);

        var user = await currentUser.GetAsync(ct);
        var now = clock.GetUtcNow();
        var group = new Group { Id = body.Id, Name = name, BaseCurrency = body.BaseCurrency!, CreatedByUserId = user.Id, CreatedAt = now };
        var member = new Member
        {
            Id = Guid.NewGuid(), GroupId = group.Id, UserId = user.Id, JoinedAt = now,
            DisplayName = user.DisplayName.Length > 40 ? user.DisplayName[..40] : user.DisplayName,
        };
        db.AddRange(group, member);

        var dto = group.ToDto([member]);
        audit.Record(user.Id, group.Id, EntityType, group.Id, AuditActions.Created, null, new { group.Name, group.BaseCurrency });
        audit.Record(user.Id, group.Id, MemberEndpoints.EntityType, member.Id, AuditActions.Created, null, member.ToDto());
        await db.SaveChangesAsync(ct);
        return Results.Created($"/groups/{group.Id}", dto);
    }

    private static async Task<IResult> ListAsync(ICurrentUser currentUser, LedgerDbContext db, CancellationToken ct)
    {
        var user = await currentUser.GetAsync(ct);
        var groups = await db.Groups
            .Where(g => g.Members.Any(m => m.UserId == user.Id))
            .OrderBy(g => g.Name)
            .Select(g => new { g.Id, g.Name, g.BaseCurrency, g.CreatedAt, MemberCount = g.Members.Count })
            .ToListAsync(ct);

        var myMembers = await db.Members.Where(m => m.UserId == user.Id).ToDictionaryAsync(m => m.GroupId, m => m.Id, ct);
        var summaries = new List<GroupSummaryDto>(groups.Count);
        foreach (var g in groups)
        {
            var nets = await Balances.BalanceQueries.NetByCurrencyAsync(db, g.Id, ct);
            var myNet = nets.OrderBy(kv => kv.Key, StringComparer.Ordinal)
                .Select(kv => new NetDto(kv.Key, kv.Value.GetValueOrDefault(myMembers[g.Id])))
                .Where(n => n.NetMinor != 0)
                .ToList();
            summaries.Add(new GroupSummaryDto(g.Id, g.Name, g.BaseCurrency.Trim(), g.MemberCount, myNet, g.CreatedAt));
        }
        return Results.Ok(summaries);
    }

    private static async Task<IResult> GetAsync(Guid groupId, LedgerDbContext db, CancellationToken ct)
    {
        var group = await db.Groups.Include(g => g.Members).SingleAsync(g => g.Id == groupId, ct);
        return Results.Ok(group.ToDto(group.Members));
    }

    private static async Task<IResult> UpdateAsync(Guid groupId, UpdateGroupDto body, HttpContext http, LedgerDbContext db,
        AuditWriter audit, CancellationToken ct)
    {
        var name = body.Name?.Trim() ?? "";
        if (name.Length is < 1 or > 60) return ApiError.Validation("name must be 1–60 characters.");

        var caller = GroupMemberFilter.CallerMember(http);
        var group = await db.Groups.Include(g => g.Members).SingleAsync(g => g.Id == groupId, ct);
        var before = new { group.Name };
        group.Name = name;
        audit.Record(caller.User.Id, group.Id, EntityType, group.Id, AuditActions.Updated, before, new { group.Name });
        await db.SaveChangesAsync(ct);
        return Results.Ok(group.ToDto(group.Members));
    }
}
