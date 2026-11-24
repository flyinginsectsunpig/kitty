using Kitty.Ledger.Data;
using Kitty.Ledger.Domain;
using Kitty.Ledger.Domain.Balances;
using Kitty.Ledger.Domain.Splits;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Balances;

public sealed record MemberNetDto(Guid MemberId, long NetMinor);
public sealed record TransferDto(Guid FromMemberId, Guid ToMemberId, long AmountMinor);
public sealed record CurrencyBalanceDto(string Currency, IReadOnlyList<MemberNetDto> Members, IReadOnlyList<TransferDto> Transfers);
/// <summary>
/// Everyone's net in the group's currency, from each row's stored rate. ExcludedCount: foreign rows with no rate yet.
/// </summary>
public sealed record ConvertedBalanceDto(string Currency, IReadOnlyList<MemberNetDto> Members, IReadOnlyList<TransferDto> Transfers,
    int ExcludedCount);

/// <summary>Converted is null when there's nothing to total: every row is in the group's currency, or everyone is square.</summary>
public sealed record BalancesDto(IReadOnlyList<CurrencyBalanceDto> Currencies, ConvertedBalanceDto? Converted);

public static class BalanceEndpoints
{
    public static void MapBalances(this RouteGroupBuilder group) =>
        group.MapGet("/balances", GetAsync).WithTags("Balances").WithName("GetBalances").Produces<BalancesDto>();

    private static async Task<IResult> GetAsync(Guid groupId, LedgerDbContext db, CancellationToken ct)
    {
        var rows = await BalanceQueries.LoadAsync(db, groupId, ct);
        var nets = rows.NetByCurrency();
        var memberIds = MemberOrder.Sort(await db.Members.Where(m => m.GroupId == groupId).Select(m => m.Id).ToListAsync(ct));

        var currencies = nets.OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => new CurrencyBalanceDto(
            kv.Key,
            memberIds.Select(id => new MemberNetDto(id, kv.Value.GetValueOrDefault(id))).ToList(),
            Transfers(kv.Value))).ToList();

        var groupCurrency = (await db.Groups.Where(g => g.Id == groupId).Select(g => g.BaseCurrency).SingleAsync(ct)).Trim();
        var everyoneSquare = nets.Values.All(n => n.Values.All(v => v == 0));
        var onlyGroupCurrency = nets.Keys.All(c => c == groupCurrency);
        ConvertedBalanceDto? converted = null;
        if (!everyoneSquare && !onlyGroupCurrency)
        {
            var (convertedNets, excluded) = rows.Converted(groupCurrency);
            converted = new ConvertedBalanceDto(groupCurrency,
                memberIds.Select(id => new MemberNetDto(id, convertedNets.GetValueOrDefault(id))).ToList(),
                Transfers(convertedNets), excluded);
        }

        return Results.Ok(new BalancesDto(currencies, converted));
    }

    private static List<TransferDto> Transfers(IReadOnlyDictionary<Guid, long> nets) =>
        DebtSimplifier.Simplify(nets).Select(t => new TransferDto(t.From, t.To, t.Minor)).ToList();
}

/// <summary>A group's non-deleted expenses and settlements, as balances need them.</summary>
public sealed record BalanceRows(IReadOnlyList<ConvertibleExpense> Expenses, IReadOnlyList<ConvertibleSettlement> Settlements)
{
    public IReadOnlyDictionary<string, IReadOnlyDictionary<Guid, long>> NetByCurrency() =>
        BalanceCalculator.NetByCurrency(
            Expenses.Select(e => new LedgerExpense(e.Currency, e.Payers, e.Shares)),
            Settlements.Select(s => new LedgerSettlement(s.Currency, s.From, s.To, s.Minor)));

    public (IReadOnlyDictionary<Guid, long> Nets, int Excluded) Converted(string groupCurrency) =>
        ConvertedBalances.Compute(groupCurrency, Expenses, Settlements);
}

public static class BalanceQueries
{
    /// <summary>Recomputes every member's net per currency from the group's non-deleted expenses and settlements.</summary>
    public static async Task<IReadOnlyDictionary<string, IReadOnlyDictionary<Guid, long>>> NetByCurrencyAsync(
        LedgerDbContext db, Guid groupId, CancellationToken ct) =>
        (await LoadAsync(db, groupId, ct)).NetByCurrency();

    public static async Task<BalanceRows> LoadAsync(LedgerDbContext db, Guid groupId, CancellationToken ct)
    {
        var expenses = await db.Expenses.AsNoTracking()
            .Where(e => e.GroupId == groupId && e.DeletedAt == null)
            .Select(e => new { e.Currency, e.FxRate, e.Payers, e.Shares })
            .ToListAsync(ct);
        var settlements = await db.Settlements.AsNoTracking()
            .Where(s => s.GroupId == groupId && s.DeletedAt == null)
            .Select(s => new { s.Currency, s.FromMemberId, s.ToMemberId, s.AmountMinor, s.ConvertedAmountMinor })
            .ToListAsync(ct);

        return new BalanceRows(
            expenses.Select(e => new ConvertibleExpense(e.Currency.Trim(), e.FxRate,
                e.Payers.Select(p => new Share(p.MemberId, p.AmountMinor)).ToList(),
                e.Shares.Select(s => new Share(s.MemberId, s.AmountMinor)).ToList())).ToList(),
            settlements.Select(s => new ConvertibleSettlement(s.Currency.Trim(), s.FromMemberId, s.ToMemberId, s.AmountMinor,
                s.ConvertedAmountMinor)).ToList());
    }
}
