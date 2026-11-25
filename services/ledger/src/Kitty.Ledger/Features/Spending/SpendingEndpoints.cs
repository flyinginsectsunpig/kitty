using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Features.Common;
using Kitty.Ledger.Features.Groups;
using Kitty.Ledger.Infrastructure.Errors;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Spending;

public static class SpendingEndpoints
{
    private const int MaxText = 100;
    private const int ListSize = 5;

    public static void MapSpending(this RouteGroupBuilder group) =>
        group.MapGet("/spending", GetAsync).WithTags("Spending").WithName("GetSpending").Produces<SpendingDto>();

    /// <summary>
    /// The group's non-deleted expenses with OccurredOn in [from, to], optionally one category and a description containing q.
    /// Settlements are not spending.
    /// </summary>
    private static async Task<IResult> GetAsync(Guid groupId, [FromQuery(Name = "from")] DateOnly? fromDate,
        [FromQuery(Name = "to")] DateOnly? toDate, string? category, string? q, HttpContext http, LedgerDbContext db, CancellationToken ct)
    {
        var text = string.IsNullOrWhiteSpace(q) ? null : q.Trim();
        if (fromDate > toDate) return ApiError.Validation("from must not be after to.");
        if (category is not null && !Categories.All.Contains(category)) return ApiError.Validation($"'{category}' is not a category.");
        if (text?.Length > MaxText) return ApiError.Validation($"q must be at most {MaxText} characters.");

        var me = GroupMemberFilter.CallerMember(http).Member.Id;
        var query = db.Expenses.AsNoTracking().Where(e => e.GroupId == groupId && e.DeletedAt == null);
        if (fromDate is { } from) query = query.Where(e => e.OccurredOn >= from);
        if (toDate is { } to) query = query.Where(e => e.OccurredOn <= to);
        if (category is not null) query = query.Where(e => e.Category == category);
        var rows = await query.ToListAsync(ct);
        if (text is not null) rows = rows.Where(e => e.Description.Contains(text, StringComparison.OrdinalIgnoreCase)).ToList();

        var names = await db.Members.Where(m => m.GroupId == groupId).ToDictionaryAsync(m => m.Id, m => m.DisplayName, ct);
        var groupCurrency = (await db.Groups.Where(g => g.Id == groupId).Select(g => g.BaseCurrency).SingleAsync(ct)).Trim();

        var currencies = rows.GroupBy(e => e.Currency.Trim()).OrderBy(g => g.Key, StringComparer.Ordinal)
            .Select(g => Currency(g.Key, g.ToList(), me, names)).ToList();
        var converted = currencies.Count > 1 ? Converted(rows, groupCurrency) : null;
        return Results.Ok(new SpendingDto(groupCurrency, currencies, converted));
    }

    private static SpendingCurrencyDto Currency(string currency, List<Expense> rows, Guid me, IReadOnlyDictionary<Guid, string> names)
    {
        MoneyDto M(long minor) => MoneyDto.Of(minor, currency);
        ExpenseLineDto Line(Expense e) => ExpenseLineDto.Of(e, me, names);

        var byCategory = rows.GroupBy(e => e.Category).Select(g => (Name: g.Key, Sum: g.Sum(e => e.AmountMinor)))
            .OrderByDescending(c => c.Sum).ThenBy(c => c.Name, StringComparer.Ordinal)
            .Select(c => new CategoryTotalDto(c.Name, M(c.Sum))).ToList();
        var byPayer = rows.SelectMany(e => e.Payers).GroupBy(p => p.MemberId)
            .Select(g => (Id: g.Key, Name: names.GetValueOrDefault(g.Key) ?? "someone", Sum: g.Sum(p => p.AmountMinor)))
            .OrderByDescending(p => p.Sum).ThenBy(p => p.Name, StringComparer.Ordinal)
            .Select(p => new PayerTotalDto(p.Id, p.Name, M(p.Sum))).ToList();
        var biggest = rows.OrderByDescending(e => e.AmountMinor).ThenByDescending(e => e.OccurredOn).ThenBy(e => e.Id)
            .Take(ListSize).Select(Line).ToList();
        var latest = rows.OrderByDescending(e => e.OccurredOn).ThenByDescending(e => e.CreatedAt).ThenBy(e => e.Id)
            .Take(ListSize).Select(Line).ToList();

        return new SpendingCurrencyDto(currency, M(rows.Sum(e => e.AmountMinor)),
            M(rows.SelectMany(e => e.Shares).Where(s => s.MemberId == me).Sum(s => s.AmountMinor)), rows.Count,
            byCategory, byPayer, biggest, latest);
    }

    private static ConvertedSpendingDto Converted(List<Expense> rows, string groupCurrency)
    {
        long total = 0;
        var excluded = 0;
        foreach (var e in rows)
        {
            if (e.Currency.Trim() == groupCurrency) total += e.AmountMinor;
            else if (e.ConvertedAmountMinor is { } c) total += c;
            else excluded++;
        }
        return new ConvertedSpendingDto(MoneyDto.Of(total, groupCurrency), excluded);
    }
}
