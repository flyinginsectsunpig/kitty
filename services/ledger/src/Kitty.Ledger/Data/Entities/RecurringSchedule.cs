using Kitty.Ledger.Domain.Recurring;
using Kitty.Ledger.Features.Expenses;

namespace Kitty.Ledger.Data.Entities;

/// <summary>What each period's expense looks like (stored as JSON): the expense form minus its date.</summary>
public sealed record ExpenseTemplate(string Description, string Category, string Currency, long AmountMinor,
    IReadOnlyList<PayerDto> Payers, SplitDto Split);

/// <summary>
/// An expense that repeats. pulse adds each period (over gRPC) when it falls due; <see cref="NotBefore"/> and
/// <see cref="LastAddedPeriod"/> keep a period from being added twice or while it shouldn't be.
/// </summary>
public sealed class RecurringSchedule
{
    public Guid Id { get; set; }
    public Guid GroupId { get; set; }
    public Guid CreatedByUserId { get; set; }
    public required ExpenseTemplate Template { get; set; }
    public Frequency Frequency { get; set; }
    /// <summary>The first period, and where the rule comes from (its weekday or day of the month).</summary>
    public DateOnly StartsOn { get; set; }
    public DateOnly? EndsOn { get; set; }
    /// <summary>Periods before this are never added: the start date, the resume date, or the cycle after a rule change.</summary>
    public DateOnly NotBefore { get; set; }
    public bool Paused { get; set; }
    public DateOnly? LastAddedPeriod { get; set; }
    public int Version { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }

    public Rule Rule => new(Frequency, StartsOn);
}
