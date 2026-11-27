using Kitty.Ledger.Data;
using Kitty.Ledger.Features.Common;
using Kitty.Ledger.Infrastructure.Errors;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Settlements;

/// <summary>One item still open between the two. Item.MyShare is the debtor's share; Open is what they still owe on it.</summary>
public sealed record OpenItemDto(ExpenseLineDto Item, MoneyDto Open);

/// <summary>FromOwes: what From still owes To, item by item, newest first. ToOwes: the other way round.</summary>
public sealed record OpenItemsCurrencyDto(string Currency, IReadOnlyList<OpenItemDto> FromOwes, MoneyDto FromOwesTotal,
    IReadOnlyList<OpenItemDto> ToOwes, MoneyDto ToOwesTotal);

/// <summary>Only the currencies with something open in either direction.</summary>
public sealed record OpenItemsDto(Guid FromMemberId, Guid ToMemberId, IReadOnlyList<OpenItemsCurrencyDto> Currencies);

public static class OpenItemsEndpoints
{
    public static void MapOpenItems(this RouteGroupBuilder group) =>
        group.MapGet("/open-items", GetAsync).WithTags("Settlements").WithName("GetOpenItems").Produces<OpenItemsDto>();

    /// <summary>What's still open between two members, each way, after the payments that said which items they covered.</summary>
    private static async Task<IResult> GetAsync(Guid groupId, [FromQuery(Name = "from")] Guid fromMember,
        [FromQuery(Name = "to")] Guid toMember, LedgerDbContext db, CancellationToken ct)
    {
        if (fromMember == toMember) return ApiError.Validation("from and to must be two different members.");
        var names = await db.Members.AsNoTracking().Where(m => m.GroupId == groupId).ToDictionaryAsync(m => m.Id, m => m.DisplayName, ct);
        if (!names.ContainsKey(fromMember) || !names.ContainsKey(toMember))
            return ApiError.BadRequest(ErrorCodes.MemberNotInGroup, "Both members must be in this group.");

        var expenses = await db.Expenses.AsNoTracking().Where(e => e.GroupId == groupId && e.DeletedAt == null).ToListAsync(ct);
        var settlements = await db.Settlements.AsNoTracking().Where(s => s.GroupId == groupId && s.DeletedAt == null).ToListAsync(ct);

        var currencies = new List<OpenItemsCurrencyDto>();
        foreach (var currency in expenses.Select(e => e.Currency.Trim()).Distinct().OrderBy(c => c, StringComparer.Ordinal))
        {
            var fromOwes = Lines(OpenItems.Between(expenses, settlements, currency, fromMember, toMember), fromMember, currency);
            var toOwes = Lines(OpenItems.Between(expenses, settlements, currency, toMember, fromMember), toMember, currency);
            if (fromOwes.Count == 0 && toOwes.Count == 0) continue;
            currencies.Add(new OpenItemsCurrencyDto(currency, fromOwes, Total(fromOwes, currency), toOwes, Total(toOwes, currency)));
        }
        return Results.Ok(new OpenItemsDto(fromMember, toMember, currencies));

        List<OpenItemDto> Lines(IReadOnlyList<OpenItems.OpenItem> items, Guid debtor, string currency) =>
            items.Select(i => new OpenItemDto(ExpenseLineDto.Of(i.Expense, debtor, names), MoneyDto.Of(i.Open, currency))).ToList();
    }

    private static MoneyDto Total(List<OpenItemDto> items, string currency) => MoneyDto.Of(items.Sum(i => i.Open.Minor), currency);
}
