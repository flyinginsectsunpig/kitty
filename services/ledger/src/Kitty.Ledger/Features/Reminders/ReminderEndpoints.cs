using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Domain.Balances;
using Kitty.Ledger.Features.Balances;
using Kitty.Ledger.Features.Groups;
using Kitty.Ledger.Features.Notifications;
using Kitty.Ledger.Infrastructure.Errors;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Kitty.Ledger.Features.Reminders;

public sealed record ReminderWriteDto(Guid MemberId);

/// <summary>
/// Reminds a member what they owe the caller: the payments from them to the caller in the group's settle-up plan, per
/// currency. At most once per sender, member and UTC day, so it can't be used to nag.
/// </summary>
public static class ReminderEndpoints
{
    public static void MapReminders(this RouteGroupBuilder group) =>
        group.MapPost("/reminders", CreateAsync).WithTags("Reminders").WithName("CreateReminder")
            .Produces(StatusCodes.Status204NoContent);

    private static async Task<IResult> CreateAsync(Guid groupId, ReminderWriteDto body, HttpContext http, LedgerDbContext db,
        Notifier notifier, TimeProvider clock, CancellationToken ct)
    {
        var caller = GroupMemberFilter.CallerMember(http);
        var member = await db.Members.SingleOrDefaultAsync(m => m.GroupId == groupId && m.Id == body.MemberId, ct);
        if (member is null) return ApiError.NotFound();
        if (member.Id == caller.Member.Id) return ApiError.Validation("You can't remind yourself.");
        if (member.UserId is not { } memberUserId)
            return ApiError.Conflict(ErrorCodes.NoAccount, "They haven't joined Kitty, so there's no one to tell.");

        var nets = (await BalanceQueries.LoadAsync(db, groupId, ct)).NetByCurrency();
        var owed = nets.OrderBy(n => n.Key, StringComparer.Ordinal)
            .Select(n => (Currency: n.Key, Minor: DebtSimplifier.Simplify(n.Value)
                .Where(t => t.From == member.Id && t.To == caller.Member.Id).Sum(t => t.Minor)))
            .Where(o => o.Minor > 0).ToList();
        if (owed.Count == 0) return ApiError.Conflict(ErrorCodes.NothingOwed, "They don't owe you anything in this group.");

        var now = clock.GetUtcNow();
        var day = DateOnly.FromDateTime(now.UtcDateTime);
        if (await db.Reminders.AnyAsync(r => r.GroupId == groupId && r.FromMemberId == caller.Member.Id && r.ToMemberId == member.Id
                && r.Day == day, ct))
            return AlreadyReminded();

        db.Reminders.Add(new Reminder { GroupId = groupId, FromMemberId = caller.Member.Id, ToMemberId = member.Id, Day = day, CreatedAt = now });
        await notifier.ReminderAsync(groupId, caller.Member.DisplayName, memberUserId, owed, ct);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            return AlreadyReminded(); // the same reminder, sent twice at once
        }
        return Results.NoContent();
    }

    private static IResult AlreadyReminded() =>
        ApiError.Problem(StatusCodes.Status429TooManyRequests, ErrorCodes.AlreadyReminded, "You've already reminded them today.");
}
