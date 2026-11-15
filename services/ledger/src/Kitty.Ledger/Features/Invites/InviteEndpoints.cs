using System.Buffers.Text;
using System.Security.Cryptography;
using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Features.Groups;
using Kitty.Ledger.Infrastructure.Audit;
using Kitty.Ledger.Infrastructure.Auth;
using Kitty.Ledger.Infrastructure.Errors;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Invites;

public sealed record CreateInviteDto(Guid? MemberId);
public sealed record InviteDto(string Token, DateTimeOffset ExpiresAt);
public sealed record InvitePreviewDto(string GroupName, string? PlaceholderName, DateTimeOffset ExpiresAt);

/// <summary>
/// Single-use invite links, valid 7 days. A placeholder invite hands that placeholder's history to whoever
/// accepts; an open invite adds a new member.
/// </summary>
public static class InviteEndpoints
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromDays(7);

    public static void MapInvites(this IEndpointRouteBuilder app, RouteGroupBuilder group)
    {
        group.MapPost("/invites", CreateAsync).WithTags("Invites").WithName("CreateInvite")
            .Produces<InviteDto>(StatusCodes.Status201Created);

        var invites = app.MapGroup("/invites/{token}").WithTags("Invites");
        invites.MapGet("/", PreviewAsync).WithName("PreviewInvite").Produces<InvitePreviewDto>();
        invites.MapPost("/accept", AcceptAsync).WithName("AcceptInvite").Produces<GroupDto>();
    }

    private static async Task<IResult> CreateAsync(Guid groupId, CreateInviteDto body, HttpContext http, LedgerDbContext db,
        TimeProvider clock, CancellationToken ct)
    {
        var caller = GroupMemberFilter.CallerMember(http);
        if (body.MemberId is { } memberId)
        {
            var target = await db.Members.SingleOrDefaultAsync(m => m.Id == memberId && m.GroupId == groupId, ct);
            if (target is null || target.UserId is not null)
                return ApiError.Validation("memberId must be a placeholder in this group.");
        }

        var invite = new Invite
        {
            Id = Guid.NewGuid(),
            GroupId = groupId,
            Token = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32)),
            MemberId = body.MemberId,
            CreatedByUserId = caller.User.Id,
            ExpiresAt = clock.GetUtcNow() + Lifetime,
        };
        db.Invites.Add(invite);
        await db.SaveChangesAsync(ct);
        return Results.Created($"/invites/{invite.Token}", new InviteDto(invite.Token, invite.ExpiresAt));
    }

    private static async Task<IResult> PreviewAsync(string token, LedgerDbContext db, TimeProvider clock, CancellationToken ct)
    {
        var invite = await db.Invites.AsNoTracking().SingleOrDefaultAsync(i => i.Token == token, ct);
        if (UsableOrError(invite, clock) is { } error) return error;

        var groupName = await db.Groups.Where(g => g.Id == invite!.GroupId).Select(g => g.Name).SingleAsync(ct);
        var placeholderName = invite!.MemberId is null
            ? null
            : await db.Members.Where(m => m.Id == invite.MemberId).Select(m => m.DisplayName).SingleAsync(ct);
        return Results.Ok(new InvitePreviewDto(groupName, placeholderName, invite.ExpiresAt));
    }

    private static async Task<IResult> AcceptAsync(string token, ICurrentUser currentUser, LedgerDbContext db,
        AuditWriter audit, TimeProvider clock, CancellationToken ct)
    {
        var invite = await db.Invites.SingleOrDefaultAsync(i => i.Token == token, ct);
        if (UsableOrError(invite, clock) is { } error) return error;

        var user = await currentUser.GetAsync(ct);
        if (await db.Members.AnyAsync(m => m.GroupId == invite!.GroupId && m.UserId == user.Id, ct))
            return ApiError.Conflict(ErrorCodes.AlreadyMember, "You are already in this group.");

        var now = clock.GetUtcNow();
        Member member;
        if (invite!.MemberId is { } placeholderId)
        {
            member = await db.Members.SingleAsync(m => m.Id == placeholderId, ct);
            if (member.UserId is not null) return ApiError.Conflict(ErrorCodes.PlaceholderClaimed);
            var before = member.ToDto();
            member.UserId = user.Id;
            audit.Record(user.Id, invite.GroupId, MemberEndpoints.EntityType, member.Id, AuditActions.Updated, before, member.ToDto());
        }
        else
        {
            member = new Member
            {
                Id = Guid.NewGuid(), GroupId = invite.GroupId, UserId = user.Id, JoinedAt = now,
                DisplayName = user.DisplayName.Length > 40 ? user.DisplayName[..40] : user.DisplayName,
            };
            db.Members.Add(member);
            audit.Record(user.Id, invite.GroupId, MemberEndpoints.EntityType, member.Id, AuditActions.Created, null, member.ToDto());
        }

        invite.UsedAt = now;
        invite.UsedByUserId = user.Id;

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            // Another accept won the race for this invite or this placeholder.
            return ApiError.Conflict(invite.MemberId is null ? ErrorCodes.InviteUsed : ErrorCodes.PlaceholderClaimed);
        }

        var group = await db.Groups.Include(g => g.Members).SingleAsync(g => g.Id == invite.GroupId, ct);
        return Results.Ok(group.ToDto(group.Members));
    }

    private static IResult? UsableOrError(Invite? invite, TimeProvider clock) => invite switch
    {
        null => ApiError.NotFound(),
        { UsedAt: not null } => ApiError.Conflict(ErrorCodes.InviteUsed, "This invite link has already been used."),
        _ when invite.ExpiresAt <= clock.GetUtcNow() => ApiError.Conflict(ErrorCodes.InviteExpired, "This invite link has expired."),
        _ => null,
    };
}
