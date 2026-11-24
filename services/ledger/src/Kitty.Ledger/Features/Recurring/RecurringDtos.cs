using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Domain.Recurring;
using Kitty.Ledger.Features.Expenses;

namespace Kitty.Ledger.Features.Recurring;

/// <summary>A repeating expense: the expense form's fields minus the date, plus how often and from when.</summary>
public sealed record RecurringWriteDto(
    Guid Id,
    string Description,
    string Category,
    string Currency,
    long AmountMinor,
    IReadOnlyList<PayerDto> Payers,
    SplitDto Split,
    Frequency Frequency,
    DateOnly StartsOn,
    DateOnly? EndsOn,
    int? Version);

public sealed record RecurringDto(
    Guid Id,
    string Description,
    string Category,
    string Currency,
    long AmountMinor,
    IReadOnlyList<PayerDto> Payers,
    SplitDto Split,
    Frequency Frequency,
    DateOnly StartsOn,
    DateOnly? EndsOn,
    bool Paused,
    DateOnly? NextDueOn,
    DateOnly? LastAddedOn,
    int Version,
    Guid CreatedBy);

public static class RecurringMapping
{
    public static RecurringDto ToDto(this RecurringSchedule s, DateOnly today)
    {
        var t = s.Template;
        return new RecurringDto(s.Id, t.Description, t.Category, t.Currency, t.AmountMinor, t.Payers, t.Split, s.Frequency,
            s.StartsOn, s.EndsOn, s.Paused, NextDue(s, today), s.LastAddedPeriod, s.Version, s.CreatedByUserId);
    }

    /// <summary>When pulse will next add a period: null while paused, deleted, or past the end date.</summary>
    public static DateOnly? NextDue(RecurringSchedule s, DateOnly today)
    {
        if (s.Paused || s.DeletedAt is not null) return null;
        var from = new[] { s.NotBefore, today, s.LastAddedPeriod?.AddDays(1) ?? DateOnly.MinValue }.Max();
        var next = Recurrence.NextOnOrAfter(s.Rule, from);
        return s.EndsOn is { } end && next > end ? null : next;
    }

    public static ExpenseWriteDto AsExpense(this ExpenseTemplate t, Guid id, DateOnly occurredOn) =>
        new(id, t.Description, t.Category, t.Currency, t.AmountMinor, occurredOn, t.Payers, t.Split, Version: null);
}
