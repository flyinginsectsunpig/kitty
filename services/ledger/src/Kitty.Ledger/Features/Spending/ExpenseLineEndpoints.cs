using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Features.Common;
using Kitty.Ledger.Features.Expenses;
using Kitty.Ledger.Features.Groups;
using Kitty.Ledger.Infrastructure.Errors;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Spending;

public sealed record ExpenseLinePageDto(IReadOnlyList<ExpenseLineDto> Items, string? NextCursor);

/// <summary>
/// The group's expenses as formatted lines (total, the caller's share, who paid), newest first, filtered in the database
/// so the keyset cursor stays correct: the list the MCP server reads. The apps' own list (ListExpenses) is unchanged.
/// </summary>
public static class ExpenseLineEndpoints
{
    private const int MaxText = 100;

    public static void MapExpenseLines(this RouteGroupBuilder group) =>
        group.MapGet("/expense-lines", ListAsync).WithTags("Spending").WithName("ListExpenseLines").Produces<ExpenseLinePageDto>();

    private static async Task<IResult> ListAsync(Guid groupId, [FromQuery(Name = "from")] DateOnly? fromDate,
        [FromQuery(Name = "to")] DateOnly? toDate, string? category, string? q, Guid? member, string? cursor, int? limit,
        HttpContext http, LedgerDbContext db, CancellationToken ct)
    {
        var size = limit ?? ExpenseEndpoints.DefaultPageSize;
        var text = string.IsNullOrWhiteSpace(q) ? null : q.Trim();
        if (size is < 1 or > ExpenseEndpoints.MaxPageSize)
            return ApiError.Validation($"limit must be between 1 and {ExpenseEndpoints.MaxPageSize}.");
        if (fromDate > toDate) return ApiError.Validation("from must not be after to.");
        if (category is not null && !Categories.All.Contains(category)) return ApiError.Validation($"'{category}' is not a category.");
        if (text?.Length > MaxText) return ApiError.Validation($"q must be at most {MaxText} characters.");
        if (member is { } m && !await db.Members.AnyAsync(x => x.Id == m && x.GroupId == groupId, ct))
            return ApiError.Validation("member is not in this group.");

        var me = GroupMemberFilter.CallerMember(http).Member.Id;
        var query = db.Expenses.AsNoTracking().Where(e => e.GroupId == groupId && e.DeletedAt == null);
        if (fromDate is { } from) query = query.Where(e => e.OccurredOn >= from);
        if (toDate is { } to) query = query.Where(e => e.OccurredOn <= to);
        if (category is not null) query = query.Where(e => e.Category == category);
        if (text is not null)
        {
            var pattern = $"%{text.Replace(@"\", @"\\").Replace("%", @"\%").Replace("_", @"\_")}%";
            query = query.Where(e => EF.Functions.ILike(e.Description, pattern, @"\"));
        }
        if (member is { } who) query = query.Where(e => e.Payers.Any(p => p.MemberId == who) || e.Shares.Any(s => s.MemberId == who));
        if (cursor is not null)
        {
            if (!ExpenseEndpoints.TryDecodeCursor(cursor, out var on, out var at, out var id)) return ApiError.Validation("cursor is not valid.");
            query = query.Where(x => EF.Functions.LessThan(ValueTuple.Create(x.OccurredOn, x.CreatedAt, x.Id), ValueTuple.Create(on, at, id)));
        }

        var rows = await query
            .OrderByDescending(x => x.OccurredOn).ThenByDescending(x => x.CreatedAt).ThenByDescending(x => x.Id)
            .Take(size + 1)
            .ToListAsync(ct);
        var page = rows.Take(size).ToList();
        var next = rows.Count > size ? ExpenseEndpoints.EncodeCursor(page[^1]) : null;

        var names = await db.Members.Where(x => x.GroupId == groupId).ToDictionaryAsync(x => x.Id, x => x.DisplayName, ct);
        return Results.Ok(new ExpenseLinePageDto(page.Select(e => ExpenseLineDto.Of(e, me, names)).ToList(), next));
    }
}
