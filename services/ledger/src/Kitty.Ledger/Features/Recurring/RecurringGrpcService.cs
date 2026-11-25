using System.Globalization;
using System.Text.Json;
using Grpc.Core;
using Kitty.Contracts.Events.V1;
using Kitty.Contracts.Ledger.V1;
using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Domain.Recurring;
using Kitty.Ledger.Features.Expenses;
using Kitty.Ledger.Features.Fx;
using Kitty.Ledger.Features.Notifications;
using Kitty.Ledger.Infrastructure;
using Kitty.Ledger.Infrastructure.Audit;
using Kitty.Ledger.Infrastructure.Messaging;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Kitty.Ledger.Features.Recurring;

/// <summary>
/// pulse adds a due period of a schedule. Only pulse may call this (policy "pulse", internal port), and the ledger
/// still checks everything: the schedule is live, the period is a real occurrence in range, and it isn't due later.
/// </summary>
public sealed class RecurringGrpcService(LedgerDbContext db, ExpenseRates rates, AuditWriter audit, Outbox outbox, Notifier notifier,
    TimeProvider clock)
    : RecurringService.RecurringServiceBase
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web)
    {
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public override async Task<AddOccurrenceResponse> AddOccurrence(AddOccurrenceRequest request, ServerCallContext context)
    {
        var ct = context.CancellationToken;
        if (!Guid.TryParse(request.ScheduleId, out var scheduleId)
            || !DateOnly.TryParseExact(request.Period, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var period))
            throw new RpcException(new Status(StatusCode.InvalidArgument, "schedule_id must be a UUID and period YYYY-MM-DD."));

        var schedule = await db.RecurringSchedules.SingleOrDefaultAsync(s => s.Id == scheduleId, ct)
            ?? throw new RpcException(new Status(StatusCode.NotFound, "No such schedule."));
        if (await AlreadyAddedAsync(scheduleId, period, ct) is { } existing) return existing;

        var today = DateOnly.FromDateTime(clock.GetUtcNow().UtcDateTime);
        if (schedule.DeletedAt is not null) throw Precondition("The schedule was deleted.");
        if (schedule.Paused) throw Precondition("The schedule is paused.");
        if (period < schedule.NotBefore) throw Precondition("That period is before the schedule's first one.");
        if (schedule.EndsOn is { } end && period > end) throw Precondition("The schedule has ended.");
        if (!Recurrence.IsOccurrence(schedule.Rule, period)) throw Precondition("That date isn't one of the schedule's periods.");
        // Only a real, future period is worth retrying (pulse's clock a little ahead of ours at midnight).
        if (period > today) throw new RpcException(new Status(StatusCode.Unavailable, "not due yet"));

        var body = schedule.Template.AsExpense(Guid.NewGuid(), period);
        var memberIds = await db.Members.Where(m => m.GroupId == schedule.GroupId).Select(m => m.Id).ToListAsync(ct);
        if (ExpenseValidator.Validate(body, memberIds.ToHashSet()) is not ExpenseValidation.Valid valid)
            throw Precondition("The schedule's expense is no longer valid.");

        var groupCurrency = await ExpenseEndpoints.GroupCurrencyAsync(db, schedule.GroupId, ct);
        var decision = await rates.DecideAsync(body.Currency, groupCurrency, period, null, null, ct);

        var expense = ExpenseEndpoints.NewExpense(schedule.GroupId, body, valid.Shares, schedule.CreatedByUserId, clock.NowMicros());
        ExpenseEndpoints.ApplyRate(expense, decision, groupCurrency, withoutRateIfTooLarge: true);
        expense.RecurringScheduleId = scheduleId;
        expense.RecurringPeriod = period;
        db.Expenses.Add(expense);
        if (schedule.LastAddedPeriod is null || period > schedule.LastAddedPeriod) schedule.LastAddedPeriod = period;

        // The activity feed says it was added automatically, for the person who set the schedule up.
        var snapshot = JsonSerializer.SerializeToNode(expense.ToDto(), Web)!.AsObject();
        snapshot["recurringScheduleId"] = scheduleId.ToString();
        audit.Record(schedule.CreatedByUserId, schedule.GroupId, ExpenseEndpoints.EntityType, expense.Id, AuditActions.Created, null, snapshot);
        outbox.ExpenseChanged(schedule.GroupId, expense.Id, ExpenseChanged.Types.Change.Created);
        await notifier.ExpenseAddedAsync(expense, actorUserId: null, ct); // nobody added it just now: everyone involved hears
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException e) when (e.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            // Another call added this period first.
            db.ChangeTracker.Clear();
            var added = await AlreadyAddedAsync(scheduleId, period, ct);
            if (added is null) throw;
            return added;
        }
        return new AddOccurrenceResponse { ExpenseId = expense.Id.ToString(), AlreadyAdded = false };
    }

    private async Task<AddOccurrenceResponse?> AlreadyAddedAsync(Guid scheduleId, DateOnly period, CancellationToken ct) =>
        await db.Expenses.AsNoTracking()
            .Where(e => e.RecurringScheduleId == scheduleId && e.RecurringPeriod == period)
            .Select(e => (Guid?)e.Id).SingleOrDefaultAsync(ct) is { } id
            ? new AddOccurrenceResponse { ExpenseId = id.ToString(), AlreadyAdded = true }
            : null;

    private static RpcException Precondition(string detail) => new(new Status(StatusCode.FailedPrecondition, detail));
}
