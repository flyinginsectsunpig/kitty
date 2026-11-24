namespace Kitty.Ledger.Domain.Recurring;

public enum Frequency { Weekly, Monthly }

/// <summary>A repeat rule, taken from its start date: weekly on that weekday, or monthly on that day of the month.</summary>
public sealed record Rule(Frequency Frequency, DateOnly StartsOn);

/// <summary>
/// When a rule falls due. Monthly on the 29th–31st lands on the last day of shorter months, without carrying forward
/// (31 Jan, 28 Feb, 31 Mar). pulse's Go copy runs the same fixture (contracts/fixtures/recurrence.json).
/// </summary>
public static class Recurrence
{
    /// <summary>Every occurrence in [from, to], oldest first. Never before the start date.</summary>
    public static IReadOnlyList<DateOnly> Between(Rule rule, DateOnly from, DateOnly to)
    {
        var result = new List<DateOnly>();
        if (from < rule.StartsOn) from = rule.StartsOn;
        if (from > to) return result;

        for (var k = FirstIndexNear(rule, from); ; k++)
        {
            var d = Occurrence(rule, k);
            if (d > to) return result;
            if (d >= from) result.Add(d);
        }
    }

    public static bool IsOccurrence(Rule rule, DateOnly date) =>
        date >= rule.StartsOn && Between(rule, date, date).Count == 1;

    /// <summary>The first occurrence on or after <paramref name="date"/>.</summary>
    public static DateOnly NextOnOrAfter(Rule rule, DateOnly date)
    {
        if (date < rule.StartsOn) date = rule.StartsOn;
        for (var k = FirstIndexNear(rule, date); ; k++)
            if (Occurrence(rule, k) is var d && d >= date) return d;
    }

    /// <summary>The first day of the cycle after the one holding <paramref name="period"/>: the next month's 1st, or the next Monday.</summary>
    public static DateOnly NextCycleStart(Frequency frequency, DateOnly period) => frequency switch
    {
        Frequency.Monthly => new DateOnly(period.Year, period.Month, 1).AddMonths(1),
        _ => period.AddDays(8 - IsoWeekday(period)),
    };

    private static DateOnly Occurrence(Rule rule, int k)
    {
        if (rule.Frequency == Frequency.Weekly) return rule.StartsOn.AddDays(7 * k);
        var month = new DateOnly(rule.StartsOn.Year, rule.StartsOn.Month, 1).AddMonths(k);
        return month.AddDays(Math.Min(rule.StartsOn.Day, DateTime.DaysInMonth(month.Year, month.Month)) - 1);
    }

    /// <summary>An occurrence index at or just before <paramref name="date"/>, so loops don't walk from the start.</summary>
    private static int FirstIndexNear(Rule rule, DateOnly date) => rule.Frequency == Frequency.Weekly
        ? Math.Max(0, (date.DayNumber - rule.StartsOn.DayNumber) / 7)
        : Math.Max(0, (date.Year - rule.StartsOn.Year) * 12 + date.Month - rule.StartsOn.Month - 1);

    private static int IsoWeekday(DateOnly d) => d.DayOfWeek == DayOfWeek.Sunday ? 7 : (int)d.DayOfWeek;
}
