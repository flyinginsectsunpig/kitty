using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Domain.Balances;
using Kitty.Ledger.Features.Balances;
using Kitty.Ledger.Features.Common;
using Kitty.Ledger.Features.Settlements;
using Kitty.Ledger.Infrastructure.Auth;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Owing;

public static class OwingEndpoints
{
    private const int MaxSince = 10;
    private static readonly TimeSpan SouthAfrica = TimeSpan.FromHours(2);

    public static void MapOwing(this RouteGroupBuilder me) =>
        me.MapGet("/owing", GetAsync).WithTags("Me").WithName("GetOwing").Produces<OwingDto>();

    /// <summary>
    /// Every group I'm in where I'm not square, with my part of each group's settle-up plan (the same plan /balances and
    /// reminders use), the items still open between me and anyone else, and the payments since I was last square; plus the
    /// totals and the people, summed across groups.
    /// </summary>
    private static async Task<IResult> GetAsync(ICurrentUser current, LedgerDbContext db, CancellationToken ct)
    {
        var user = await current.GetAsync(ct);
        var myMembers = await db.Members.AsNoTracking().Where(m => m.UserId == user.Id).ToDictionaryAsync(m => m.GroupId, m => m.Id, ct);
        var groupIds = myMembers.Keys.ToList();
        var groups = await db.Groups.AsNoTracking().Where(g => groupIds.Contains(g.Id)).OrderBy(g => g.Name).ThenBy(g => g.Id)
            .Select(g => new { g.Id, g.Name }).ToListAsync(ct);

        var people = new Dictionary<string, Person>(StringComparer.Ordinal);
        var result = new List<OwingGroupDto>();
        foreach (var g in groups)
        {
            var me = myMembers[g.Id];
            var nets = (await BalanceQueries.LoadAsync(db, g.Id, ct)).NetByCurrency();
            var owing = nets.Where(kv => kv.Value.GetValueOrDefault(me) != 0).OrderBy(kv => kv.Key, StringComparer.Ordinal).ToList();
            if (owing.Count == 0) continue;

            var members = await db.Members.AsNoTracking().Where(m => m.GroupId == g.Id).ToDictionaryAsync(m => m.Id, ct);
            var names = members.ToDictionary(kv => kv.Key, kv => kv.Value.DisplayName);
            var expenses = await db.Expenses.AsNoTracking().Where(e => e.GroupId == g.Id && e.DeletedAt == null).ToListAsync(ct);
            var settlements = await db.Settlements.AsNoTracking().Where(s => s.GroupId == g.Id && s.DeletedAt == null).ToListAsync(ct);
            var effective = OpenItems.Effective(expenses, settlements);

            var currencies = new List<OwingCurrencyDto>();
            foreach (var (currency, net) in owing)
            {
                MoneyDto M(long minor) => MoneyDto.Of(minor, currency);
                var transfers = DebtSimplifier.Simplify(net).Where(t => t.From == me || t.To == me)
                    .Select(t => t.From == me
                        ? new OwingTransferDto("i_pay", t.To, names[t.To], M(t.Minor))
                        : new OwingTransferDto("pays_me", t.From, names[t.From], M(t.Minor)))
                    .ToList();
                foreach (var t in transfers)
                    PersonFor(people, members[t.MemberId]).Add(t.Direction, currency, t.Amount.Minor, g.Name);

                var items = OpenLines(expenses, settlements, currency, me, names);
                var payments = LastSquare.Since(RecordedRows.Order(expenses, settlements, currency, me)).OfType<Settlement>()
                    .OrderByDescending(s => s.CreatedAt)
                    .Select(s => new OwingPaymentDto(names[s.FromMemberId], names[s.ToMemberId], M(s.AmountMinor),
                        DateOnly.FromDateTime(s.CreatedAt.ToOffset(SouthAfrica).DateTime),
                        M(s.AmountMinor - s.Covers.Sum(c => effective.GetValueOrDefault((s.Id, c.ExpenseId))))))
                    .ToList();
                currencies.Add(new OwingCurrencyDto(currency, M(net[me]), transfers, items.Take(MaxSince).ToList(),
                    Math.Max(0, items.Count - MaxSince), payments));
            }
            result.Add(new OwingGroupDto(g.Id, g.Name, currencies));
        }

        var userIds = people.Values.Where(p => p.UserId is not null).Select(p => p.UserId!.Value).ToList();
        var accountNames = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.DisplayName, ct);
        var personDtos = people.Values
            .Select(p => new OwingPersonDto(p.UserId, p.UserId is null ? p.MemberId : null,
                p.UserId is { } uid ? accountNames.GetValueOrDefault(uid) ?? p.MemberName : p.MemberName,
                Money(p.IOwe), Money(p.OwesMe), p.Groups))
            .OrderBy(p => p.Name, StringComparer.Ordinal).ThenBy(p => p.UserId).ThenBy(p => p.MemberId)
            .ToList();

        var iOwe = new Dictionary<string, long>(StringComparer.Ordinal);
        var owedToMe = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var p in people.Values)
        {
            foreach (var (c, v) in p.IOwe) iOwe[c] = iOwe.GetValueOrDefault(c) + v;
            foreach (var (c, v) in p.OwesMe) owedToMe[c] = owedToMe.GetValueOrDefault(c) + v;
        }
        return Results.Ok(new OwingDto(Money(iOwe), Money(owedToMe), personDtos, result));
    }

    /// <summary>
    /// The items with something still open between me and any other member, either way, newest first, each with who
    /// it's open with.
    /// </summary>
    private static List<OwingLineDto> OpenLines(List<Expense> expenses, List<Settlement> settlements, string currency, Guid me,
        IReadOnlyDictionary<Guid, string> names)
    {
        var open = new List<(Expense Expense, OpenWithDto With)>();
        foreach (var other in names.Keys.Where(id => id != me))
        {
            foreach (var i in OpenItems.Between(expenses, settlements, currency, me, other))
                open.Add((i.Expense, new OpenWithDto(other, names[other], "i_pay", MoneyDto.Of(i.Open, currency))));
            foreach (var i in OpenItems.Between(expenses, settlements, currency, other, me))
                open.Add((i.Expense, new OpenWithDto(other, names[other], "pays_me", MoneyDto.Of(i.Open, currency))));
        }
        return open.GroupBy(o => o.Expense.Id)
            .Select(g => (Expense: g.First().Expense,
                With: g.Select(o => o.With).OrderBy(w => w.Name, StringComparer.Ordinal).ThenBy(w => w.MemberId).ThenBy(w => w.Direction,
                    StringComparer.Ordinal).ToList()))
            .OrderByDescending(x => x.Expense.OccurredOn).ThenByDescending(x => x.Expense.CreatedAt).ThenBy(x => x.Expense.Id)
            .Select(x =>
            {
                var line = ExpenseLineDto.Of(x.Expense, me, names);
                return new OwingLineDto(line.ExpenseId, line.Description, line.Date, line.Category, line.Total, line.MyShare, line.PaidBy,
                    x.With);
            })
            .ToList();
    }

    private static Person PersonFor(Dictionary<string, Person> people, Member m)
    {
        var key = m.UserId is { } uid ? $"u:{uid}" : $"m:{m.Id}";
        if (!people.TryGetValue(key, out var p)) people[key] = p = new Person(m.UserId, m.Id, m.DisplayName);
        return p;
    }

    private static List<MoneyDto> Money(Dictionary<string, long> byCurrency) =>
        byCurrency.OrderBy(kv => kv.Key, StringComparer.Ordinal).Select(kv => MoneyDto.Of(kv.Value, kv.Key)).ToList();

    private sealed class Person(Guid? userId, Guid memberId, string memberName)
    {
        public Guid? UserId { get; } = userId;
        public Guid MemberId { get; } = memberId;
        public string MemberName { get; } = memberName;
        public Dictionary<string, long> IOwe { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, long> OwesMe { get; } = new(StringComparer.Ordinal);
        public List<string> Groups { get; } = [];

        public void Add(string direction, string currency, long minor, string group)
        {
            var into = direction == "i_pay" ? IOwe : OwesMe;
            into[currency] = into.GetValueOrDefault(currency) + minor;
            if (!Groups.Contains(group)) Groups.Add(group);
        }
    }
}
