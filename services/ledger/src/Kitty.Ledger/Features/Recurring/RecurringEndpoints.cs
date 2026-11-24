using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Domain.Recurring;
using Kitty.Ledger.Domain.Splits;
using Kitty.Ledger.Features.Expenses;
using Kitty.Ledger.Features.Groups;
using Kitty.Ledger.Infrastructure;
using Kitty.Ledger.Infrastructure.Audit;
using Kitty.Ledger.Infrastructure.Errors;
using Kitty.Ledger.Infrastructure.Messaging;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Recurring;

/// <summary>Repeating expenses. Every change goes to the ledger.recurring topic, which pulse follows to add periods.</summary>
public static class RecurringEndpoints
{
    public const string EntityType = "recurring";

    public static void MapRecurring(this RouteGroupBuilder group)
    {
        var r = group.MapGroup("/recurring").WithTags("Recurring");
        r.MapGet("/", ListAsync).WithName("ListRecurring").Produces<List<RecurringDto>>();
        r.MapGet("/{scheduleId:guid}", GetAsync).WithName("GetRecurring").Produces<RecurringDto>();
        r.MapPost("/", CreateAsync).WithName("CreateRecurring").Produces<RecurringDto>(StatusCodes.Status201Created);
        r.MapPut("/{scheduleId:guid}", UpdateAsync).WithName("UpdateRecurring").Produces<RecurringDto>();
        r.MapPost("/{scheduleId:guid}/pause", (Guid groupId, Guid scheduleId, HttpContext http, LedgerDbContext db, AuditWriter audit,
            Outbox outbox, TimeProvider clock, CancellationToken ct) => SetPausedAsync(groupId, scheduleId, true, http, db, audit, outbox, clock, ct))
            .WithName("PauseRecurring").Produces<RecurringDto>();
        r.MapPost("/{scheduleId:guid}/resume", (Guid groupId, Guid scheduleId, HttpContext http, LedgerDbContext db, AuditWriter audit,
            Outbox outbox, TimeProvider clock, CancellationToken ct) => SetPausedAsync(groupId, scheduleId, false, http, db, audit, outbox, clock, ct))
            .WithName("ResumeRecurring").Produces<RecurringDto>();
        r.MapDelete("/{scheduleId:guid}", DeleteAsync).WithName("DeleteRecurring").Produces(StatusCodes.Status204NoContent);
    }

    private static DateOnly Today(TimeProvider clock) => DateOnly.FromDateTime(clock.GetUtcNow().UtcDateTime);

    /// <summary>The earliest start date allowed: UTC's yesterday is still today west of UTC (a phone sends its local date).</summary>
    private static DateOnly EarliestStart(DateOnly today) => today.AddDays(-1);

    private static IQueryable<RecurringSchedule> Live(LedgerDbContext db, Guid groupId) =>
        db.RecurringSchedules.Where(s => s.GroupId == groupId && s.DeletedAt == null);

    private static async Task<IResult> ListAsync(Guid groupId, LedgerDbContext db, TimeProvider clock, CancellationToken ct)
    {
        var rows = await Live(db, groupId).AsNoTracking().OrderBy(s => s.CreatedAt).ThenBy(s => s.Id).ToListAsync(ct);
        return Results.Ok(rows.Select(s => s.ToDto(Today(clock))).ToList());
    }

    private static async Task<IResult> GetAsync(Guid groupId, Guid scheduleId, LedgerDbContext db, TimeProvider clock, CancellationToken ct) =>
        await Live(db, groupId).AsNoTracking().SingleOrDefaultAsync(s => s.Id == scheduleId, ct) is { } s
            ? Results.Ok(s.ToDto(Today(clock)))
            : ApiError.NotFound();

    private static async Task<IResult> CreateAsync(Guid groupId, RecurringWriteDto body, HttpContext http, LedgerDbContext db,
        AuditWriter audit, Outbox outbox, TimeProvider clock, CancellationToken ct)
    {
        var today = Today(clock);
        if (await ValidateAsync(groupId, body, db, ct) is { } invalid) return invalid;
        if (body.StartsOn < EarliestStart(today)) return ApiError.Validation("startsOn can't be in the past.");
        if (await db.RecurringSchedules.AnyAsync(s => s.Id == body.Id, ct)) return ApiError.Conflict(ErrorCodes.AlreadyExists);

        var caller = GroupMemberFilter.CallerMember(http);
        var now = clock.NowMicros();
        var schedule = new RecurringSchedule
        {
            Id = body.Id, GroupId = groupId, CreatedByUserId = caller.User.Id, Template = TemplateOf(body), Frequency = body.Frequency,
            StartsOn = body.StartsOn, EndsOn = body.EndsOn, NotBefore = body.StartsOn, Version = 1, CreatedAt = now, UpdatedAt = now,
        };
        db.RecurringSchedules.Add(schedule);
        var dto = schedule.ToDto(today);
        audit.Record(caller.User.Id, groupId, EntityType, schedule.Id, AuditActions.Created, null, dto);
        outbox.RecurringScheduleChanged(schedule);
        await db.SaveChangesAsync(ct);
        return Results.Created($"/groups/{groupId}/recurring/{schedule.Id}", dto);
    }

    private static async Task<IResult> UpdateAsync(Guid groupId, Guid scheduleId, RecurringWriteDto body, HttpContext http,
        LedgerDbContext db, AuditWriter audit, Outbox outbox, TimeProvider clock, CancellationToken ct)
    {
        var today = Today(clock);
        var s = await Live(db, groupId).SingleOrDefaultAsync(x => x.Id == scheduleId, ct);
        if (s is null) return ApiError.NotFound();
        if (body.Version is null) return ApiError.Validation("version is required when updating a schedule.");
        if (body.Version != s.Version) return VersionConflict();
        if (await ValidateAsync(groupId, body with { Id = scheduleId }, db, ct) is { } invalid) return invalid;

        if (body.StartsOn != s.StartsOn)
        {
            if (s.LastAddedPeriod is not null)
                return ApiError.Conflict(ErrorCodes.ScheduleStarted, "This schedule has already added expenses, so its start date can't change.");
            if (body.StartsOn < EarliestStart(today)) return ApiError.Validation("startsOn can't be in the past.");
        }

        var before = s.ToDto(today);
        db.Entry(s).Property(x => x.Version).OriginalValue = body.Version.Value;
        // NotBefore only ever moves for a reason, so an edit can't bring back periods a pause or an end date skipped.
        if (body.StartsOn != s.StartsOn) s.NotBefore = body.StartsOn; // only before the first period (checked above)
        else if (s.LastAddedPeriod is { } last && body.Frequency != s.Frequency)
        {
            // One expense per cycle: the new rule starts in the cycle after the last period added (in the old rule's cycles).
            var nextCycle = Recurrence.NextCycleStart(s.Frequency, last);
            s.NotBefore = new[] { today, nextCycle, s.NotBefore }.Max();
        }
        // An ended schedule that's extended carries on from today, like a resume: the gap isn't backfilled.
        if (s.EndsOn is { } oldEnd && oldEnd < today && (body.EndsOn is null || body.EndsOn > oldEnd))
            s.NotBefore = new[] { today, s.NotBefore }.Max();
        s.Template = TemplateOf(body);
        s.Frequency = body.Frequency;
        s.StartsOn = body.StartsOn;
        s.EndsOn = body.EndsOn;
        s.Version = body.Version.Value + 1;
        s.UpdatedAt = clock.NowMicros();

        var dto = s.ToDto(today);
        audit.Record(GroupMemberFilter.CallerMember(http).User.Id, groupId, EntityType, s.Id, AuditActions.Updated, before, dto);
        outbox.RecurringScheduleChanged(s);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            return VersionConflict();
        }
        return Results.Ok(dto);
    }

    private static async Task<IResult> SetPausedAsync(Guid groupId, Guid scheduleId, bool paused, HttpContext http, LedgerDbContext db,
        AuditWriter audit, Outbox outbox, TimeProvider clock, CancellationToken ct)
    {
        var today = Today(clock);
        var s = await Live(db, groupId).SingleOrDefaultAsync(x => x.Id == scheduleId, ct);
        if (s is null) return ApiError.NotFound();
        if (s.Paused == paused) return Results.Ok(s.ToDto(today));

        var before = s.ToDto(today);
        s.Paused = paused;
        if (!paused) s.NotBefore = new[] { today, s.NotBefore }.Max(); // nothing from while it was paused
        s.Version++;
        s.UpdatedAt = clock.NowMicros();
        var dto = s.ToDto(today);
        audit.Record(GroupMemberFilter.CallerMember(http).User.Id, groupId, EntityType, s.Id, AuditActions.Updated, before, dto);
        outbox.RecurringScheduleChanged(s);
        return await SaveAsync(db, ct) ?? Results.Ok(dto);
    }

    private static async Task<IResult> DeleteAsync(Guid groupId, Guid scheduleId, HttpContext http, LedgerDbContext db,
        AuditWriter audit, Outbox outbox, TimeProvider clock, CancellationToken ct)
    {
        var s = await Live(db, groupId).SingleOrDefaultAsync(x => x.Id == scheduleId, ct);
        if (s is null) return ApiError.NotFound();
        var before = s.ToDto(Today(clock));
        s.DeletedAt = clock.NowMicros();
        s.Version++;
        s.UpdatedAt = s.DeletedAt.Value;
        audit.Record(GroupMemberFilter.CallerMember(http).User.Id, groupId, EntityType, s.Id, AuditActions.Deleted, before, null);
        outbox.RecurringScheduleChanged(s);
        return await SaveAsync(db, ct) ?? Results.NoContent();
    }

    /// <summary>The template must be a valid expense (checked as one dated on the start date); no itemized splits.</summary>
    private static async Task<IResult?> ValidateAsync(Guid groupId, RecurringWriteDto body, LedgerDbContext db, CancellationToken ct)
    {
        if (body.Split?.Method == SplitMethod.Itemized)
            return ApiError.Validation("A repeating expense can't be split item by item.");
        if (body.EndsOn is { } end && end < body.StartsOn) return ApiError.Validation("endsOn can't be before startsOn.");
        var memberIds = await db.Members.Where(m => m.GroupId == groupId).Select(m => m.Id).ToListAsync(ct);
        return ExpenseValidator.Validate(TemplateOf(body).AsExpense(body.Id, body.StartsOn), memberIds.ToHashSet()) is ExpenseValidation.Invalid i
            ? ApiError.BadRequest(i.Code, i.Detail)
            : null;
    }

    private static ExpenseTemplate TemplateOf(RecurringWriteDto b) =>
        new(b.Description?.Trim() ?? "", b.Category, b.Currency, b.AmountMinor, b.Payers ?? [], b.Split);

    /// <summary>Saves; someone else changing the schedule at the same moment is a version conflict (409), not a 500.</summary>
    private static async Task<IResult?> SaveAsync(LedgerDbContext db, CancellationToken ct)
    {
        try
        {
            await db.SaveChangesAsync(ct);
            return null;
        }
        catch (DbUpdateConcurrencyException)
        {
            return VersionConflict();
        }
    }

    private static IResult VersionConflict() =>
        ApiError.Conflict(ErrorCodes.VersionConflict, "Someone else changed this schedule. Reload to see their version.");
}
