using System.Text.Json;
using Kitty.Ledger.Data;
using Kitty.Ledger.Infrastructure.Errors;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Activity;

public sealed record ActivityDto(Guid Id, DateTimeOffset At, string ActorDisplayName, string EntityType, Guid EntityId,
    string Action, JsonElement? Before, JsonElement? After);

public static class ActivityEndpoints
{
    public const int DefaultLimit = 50;
    public const int MaxLimit = 100;

    public static void MapActivity(this RouteGroupBuilder group) =>
        group.MapGet("/activity", ListAsync).WithTags("Activity").WithName("ListActivity").Produces<IReadOnlyList<ActivityDto>>();

    /// <summary>The group's audit trail, newest first; page with <c>before</c> = the oldest <c>at</c> you have.</summary>
    private static async Task<IResult> ListAsync(Guid groupId, LedgerDbContext db, CancellationToken ct,
        DateTimeOffset? before = null, int? limit = null)
    {
        var size = limit ?? DefaultLimit;
        if (size is < 1 or > MaxLimit) return ApiError.Validation($"limit must be between 1 and {MaxLimit}.");

        var rows = await db.AuditEntries.AsNoTracking()
            .Where(a => a.GroupId == groupId && (before == null || a.At < before))
            .OrderByDescending(a => a.At).ThenByDescending(a => a.Id)
            .Take(size)
            .Join(db.Users, a => a.ActorUserId, u => u.Id, (a, u) => new { a, u.DisplayName })
            .ToListAsync(ct);

        return Results.Ok(rows.Select(r => new ActivityDto(r.a.Id, r.a.At, r.DisplayName, r.a.EntityType, r.a.EntityId, r.a.Action,
            Parse(r.a.Before), Parse(r.a.After))).ToList());
    }

    private static JsonElement? Parse(string? json) => json is null ? null : JsonDocument.Parse(json).RootElement.Clone();
}
