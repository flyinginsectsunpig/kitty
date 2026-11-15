using Kitty.Ledger.Data;
using Kitty.Ledger.Domain;
using Kitty.Ledger.Domain.Balances;
using Kitty.Ledger.Domain.Splits;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Balances;

public sealed record MemberNetDto(Guid MemberId, long NetMinor);
public sealed record TransferDto(Guid FromMemberId, Guid ToMemberId, long AmountMinor);
public sealed record CurrencyBalanceDto(string Currency, IReadOnlyList<MemberNetDto> Members, IReadOnlyList<TransferDto> Transfers);
public sealed record BalancesDto(IReadOnlyList<CurrencyBalanceDto> Currencies);

public static class BalanceEndpoints
{
    public static void MapBalances(this RouteGroupBuilder group) =>
        group.MapGet("/balances", GetAsync).WithTags("Balances").WithName("GetBalances").Produces<BalancesDto>();

    private static async Task<IResult> GetAsync(Guid groupId, LedgerDbContext db, CancellationToken ct)
    {
        var nets = await BalanceQueries.NetByCurrencyAsync(db, groupId, ct);
        var memberIds = MemberOrder.Sort(await db.Members.Where(m => m.GroupId == groupId).Select(m => m.Id).ToListAsync(ct));

        var currencies = nets.OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => new CurrencyBalanceDto(
            kv.Key,
            memberIds.Select(id => new MemberNetDto(id, kv.Value.GetValueOrDefault(id))).ToList(),
            DebtSimplifier.Simplify(kv.Value).Select(t => new TransferDto(t.From, t.To, t.Minor)).ToList())).ToList();

        return Results.Ok(new BalancesDto(currencies));
    }
}

public static class BalanceQueries
{
    /// <summary>Recomputes every member's net per currency from the group's non-deleted expenses and settlements.</summary>
    public static async Task<IReadOnlyDictionary<string, IReadOnlyDictionary<Guid, long>>> NetByCurrencyAsync(
        LedgerDbContext db, Guid groupId, CancellationToken ct)
    {
        var expenses = await db.Expenses.AsNoTracking()
            .Where(e => e.GroupId == groupId && e.DeletedAt == null)
            .Select(e => new { e.Currency, e.Payers, e.Shares })
            .ToListAsync(ct);
        var settlements = await db.Settlements.AsNoTracking()
            .Where(s => s.GroupId == groupId && s.DeletedAt == null)
            .Select(s => new { s.Currency, s.FromMemberId, s.ToMemberId, s.AmountMinor })
            .ToListAsync(ct);

        return BalanceCalculator.NetByCurrency(
            expenses.Select(e => new LedgerExpense(e.Currency.Trim(),
                e.Payers.Select(p => new Share(p.MemberId, p.AmountMinor)).ToList(),
                e.Shares.Select(s => new Share(s.MemberId, s.AmountMinor)).ToList())),
            settlements.Select(s => new LedgerSettlement(s.Currency.Trim(), s.FromMemberId, s.ToMemberId, s.AmountMinor)));
    }
}
