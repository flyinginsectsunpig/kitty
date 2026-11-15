using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Features.Groups;
using Kitty.Ledger.Infrastructure.Audit;
using Kitty.Ledger.Infrastructure.Errors;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features;

public sealed record AddMemberDto(string DisplayName);
public sealed record UpdateMemberDto(string? DisplayName, string? PaymentDetails);

public static class MemberEndpoints
{
    public const string EntityType = "member";

    public static void MapMembers(this RouteGroupBuilder group)
    {
        group.MapPost("/members", AddPlaceholderAsync).WithTags("Members").WithName("AddPlaceholderMember")
            .Produces<MemberDto>(StatusCodes.Status201Created);
        group.MapPatch("/members/{memberId:guid}", UpdateAsync).WithTags("Members").WithName("UpdateMember")
            .Produces<MemberDto>();
    }

    private static async Task<IResult> AddPlaceholderAsync(Guid groupId, AddMemberDto body, HttpContext http,
        LedgerDbContext db, AuditWriter audit, TimeProvider clock, CancellationToken ct)
    {
        var name = body.DisplayName?.Trim() ?? "";
        if (name.Length is < 1 or > 40) return ApiError.Validation("displayName must be 1–40 characters.");

        var caller = GroupMemberFilter.CallerMember(http);
        var member = new Member { Id = Guid.NewGuid(), GroupId = groupId, DisplayName = name, JoinedAt = clock.GetUtcNow() };
        db.Members.Add(member);
        audit.Record(caller.User.Id, groupId, EntityType, member.Id, AuditActions.Created, null, member.ToDto());
        await db.SaveChangesAsync(ct);
        return Results.Created($"/groups/{groupId}/members/{member.Id}", member.ToDto());
    }

    /// <summary>
    /// You may rename your own member row or any placeholder; other people's rows are invisible (404).
    /// Payment details can only be set on your own row.
    /// </summary>
    private static async Task<IResult> UpdateAsync(Guid groupId, Guid memberId, UpdateMemberDto body, HttpContext http,
        LedgerDbContext db, AuditWriter audit, CancellationToken ct)
    {
        var caller = GroupMemberFilter.CallerMember(http);
        var member = await db.Members.SingleOrDefaultAsync(m => m.Id == memberId && m.GroupId == groupId, ct);
        if (member is null || (member.UserId is not null && member.UserId != caller.User.Id)) return ApiError.NotFound();

        var before = member.ToDto();
        if (body.DisplayName is not null)
        {
            var name = body.DisplayName.Trim();
            if (name.Length is < 1 or > 40) return ApiError.Validation("displayName must be 1–40 characters.");
            member.DisplayName = name;
        }
        if (body.PaymentDetails is not null)
        {
            // Payment details decide where settle-up money goes, so only the person themselves may set them.
            if (member.UserId != caller.User.Id)
                return ApiError.Validation("Only the member themselves can set payment details.");
            var details = body.PaymentDetails.Trim();
            if (details.Length > 500) return ApiError.Validation("paymentDetails must be at most 500 characters.");
            member.PaymentDetails = details.Length == 0 ? null : details;
        }

        audit.Record(caller.User.Id, groupId, EntityType, member.Id, AuditActions.Updated, before, member.ToDto());
        await db.SaveChangesAsync(ct);
        return Results.Ok(member.ToDto());
    }
}
