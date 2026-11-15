using System.Net;
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Kitty.Ledger.IntegrationTests;

public sealed record PayerDto(Guid MemberId, long AmountMinor);
public sealed record ParticipantDto(Guid MemberId, long? Value);
public sealed record SplitDto(string Method, List<ParticipantDto> Participants);
public sealed record ShareDto(Guid MemberId, long AmountMinor);
public sealed record ExpenseDto(Guid Id, string Description, string Category, string Currency, long AmountMinor,
    DateOnly OccurredOn, List<PayerDto> Payers, SplitDto Split, List<ShareDto> Shares, int Version);
public sealed record ExpensePageDto(List<ExpenseDto> Items, string? NextCursor);

public static class ExpenseData
{
    public static object Equal(Guid id, long amount, Guid payer, IEnumerable<Guid> participants, string currency = "ZAR",
        string description = "Dinner", int? version = null, DateOnly? on = null) => new
    {
        id, description, category = "food", currency, amountMinor = amount,
        occurredOn = (on ?? new DateOnly(2026, 11, 15)).ToString("yyyy-MM-dd"),
        payers = new[] { new { memberId = payer, amountMinor = amount } },
        split = new { method = "equal", participants = participants.Select(m => new { memberId = m, value = (long?)null }) },
        version,
    };

    public static async Task<ExpenseDto> AddEqualAsync(this HttpClient c, Guid groupId, long amount, Guid payer,
        IEnumerable<Guid> participants, string currency = "ZAR", DateOnly? on = null)
    {
        var r = await c.PostJsonAsync($"/groups/{groupId}/expenses", Equal(Guid.NewGuid(), amount, payer, participants, currency, on: on));
        r.EnsureSuccessStatusCode();
        return await r.ReadAsync<ExpenseDto>();
    }
}

[Collection(ApiCollection.Name)]
public class ExpenseTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private async Task<(HttpClient Owner, GroupDto Group, Guid Me, Guid Gran, Guid Sam)> ThreePersonGroupAsync()
    {
        var owner = factory.NewUser("Owner");
        var g = await owner.CreateGroupAsync();
        var gran = await owner.AddPlaceholderAsync(g.Id, "Gran");
        var sam = await owner.AddPlaceholderAsync(g.Id, "Sam");
        return (owner, g, g.Members[0].Id, gran.Id, sam.Id);
    }

    [Fact]
    public async Task Create_equal_split_returns_shares_in_member_order()
    {
        var (owner, g, me, gran, sam) = await ThreePersonGroupAsync();
        var e = await owner.AddEqualAsync(g.Id, 10000, me, [me, gran, sam]);

        var ordered = new[] { me, gran, sam }.OrderBy(x => x.ToString("D"), StringComparer.Ordinal).ToList();
        Assert.Equal(ordered, e.Shares.Select(s => s.MemberId));
        Assert.Equal([3334L, 3333L, 3333L], e.Shares.Select(s => s.AmountMinor));
        Assert.Equal(1, e.Version);
        Assert.Equal("equal", e.Split.Method);
    }

    [Fact]
    public async Task Create_with_foreign_member_returns_400()
    {
        var (owner, g, me, _, _) = await ThreePersonGroupAsync();
        var other = await factory.NewUser().CreateGroupAsync();

        var r = await owner.PostJsonAsync($"/groups/{g.Id}/expenses",
            ExpenseData.Equal(Guid.NewGuid(), 1000, me, [me, other.Members[0].Id]));
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal("member_not_in_group", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Create_with_payers_not_summing_returns_400()
    {
        var (owner, g, me, gran, _) = await ThreePersonGroupAsync();
        var r = await owner.PostJsonAsync($"/groups/{g.Id}/expenses", new
        {
            id = Guid.NewGuid(), description = "Taxi", category = "transport", currency = "ZAR", amountMinor = 1000,
            occurredOn = "2026-11-15", payers = new[] { new { memberId = me, amountMinor = 600 } },
            split = new { method = "equal", participants = new[] { new { memberId = me }, new { memberId = gran } } },
        });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal("payers_sum_mismatch", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Create_with_placeholder_participant_succeeds()
    {
        var (owner, g, me, gran, _) = await ThreePersonGroupAsync();
        var e = await owner.AddEqualAsync(g.Id, 500, gran, [me, gran]);
        Assert.Equal(gran, Assert.Single(e.Payers).MemberId);
    }

    [Fact]
    public async Task Create_with_existing_id_returns_409()
    {
        var (owner, g, me, gran, _) = await ThreePersonGroupAsync();
        var id = Guid.NewGuid();
        (await owner.PostJsonAsync($"/groups/{g.Id}/expenses", ExpenseData.Equal(id, 500, me, [me, gran]))).EnsureSuccessStatusCode();
        var r = await owner.PostJsonAsync($"/groups/{g.Id}/expenses", ExpenseData.Equal(id, 700, me, [me, gran]));
        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.Equal("already_exists", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Put_updates_and_increments_version()
    {
        var (owner, g, me, gran, _) = await ThreePersonGroupAsync();
        var e = await owner.AddEqualAsync(g.Id, 500, me, [me, gran]);

        var r = await owner.PutJsonAsync($"/groups/{g.Id}/expenses/{e.Id}",
            ExpenseData.Equal(e.Id, 800, me, [me, gran], description: "Bigger dinner", version: e.Version));
        var updated = await r.ReadAsync<ExpenseDto>();
        Assert.Equal(2, updated.Version);
        Assert.Equal(800, updated.AmountMinor);
        Assert.Equal([400L, 400L], updated.Shares.Select(s => s.AmountMinor));
    }

    [Fact]
    public async Task Put_with_stale_version_returns_409()
    {
        var (owner, g, me, gran, _) = await ThreePersonGroupAsync();
        var e = await owner.AddEqualAsync(g.Id, 500, me, [me, gran]);

        (await owner.PutJsonAsync($"/groups/{g.Id}/expenses/{e.Id}",
            ExpenseData.Equal(e.Id, 600, me, [me, gran], version: 1))).EnsureSuccessStatusCode();
        var stale = await owner.PutJsonAsync($"/groups/{g.Id}/expenses/{e.Id}",
            ExpenseData.Equal(e.Id, 700, me, [me, gran], version: 1));

        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        Assert.Equal("version_conflict", await stale.ReadCodeAsync());
    }

    [Fact]
    public async Task Delete_hides_expense_from_list()
    {
        var (owner, g, me, gran, _) = await ThreePersonGroupAsync();
        var keep = await owner.AddEqualAsync(g.Id, 500, me, [me, gran]);
        var drop = await owner.AddEqualAsync(g.Id, 700, me, [me, gran]);

        Assert.Equal(HttpStatusCode.NoContent, (await owner.DeleteAsync($"/groups/{g.Id}/expenses/{drop.Id}", key: null)).StatusCode);

        var page = (await owner.GetFromJsonAsync<ExpensePageDto>($"/groups/{g.Id}/expenses", ApiClientExtensions.Json, Ct))!;
        Assert.Equal([keep.Id], page.Items.Select(i => i.Id));
        Assert.Equal(HttpStatusCode.NotFound,
            (await owner.PutJsonAsync($"/groups/{g.Id}/expenses/{drop.Id}", ExpenseData.Equal(drop.Id, 1, me, [me], version: 1))).StatusCode);
    }

    [Fact]
    public async Task List_pages_with_cursor_without_duplicates()
    {
        var (owner, g, me, gran, _) = await ThreePersonGroupAsync();
        for (var i = 0; i < 45; i++)
            await owner.AddEqualAsync(g.Id, 100 + i, me, [me, gran], on: new DateOnly(2026, 10, 1).AddDays(i % 7));

        var seen = new List<ExpenseDto>();
        var sizes = new List<int>();
        string? cursor = null;
        do
        {
            var url = $"/groups/{g.Id}/expenses?limit=20" + (cursor is null ? "" : $"&cursor={cursor}");
            var page = (await owner.GetFromJsonAsync<ExpensePageDto>(url, ApiClientExtensions.Json, Ct))!;
            sizes.Add(page.Items.Count);
            seen.AddRange(page.Items);
            cursor = page.NextCursor;
        } while (cursor is not null);

        Assert.Equal([20, 20, 5], sizes);
        Assert.Equal(45, seen.Select(e => e.Id).Distinct().Count());
        Assert.Equal(seen.Select(e => e.OccurredOn).OrderDescending(), seen.Select(e => e.OccurredOn));
    }

    [Fact]
    public async Task Itemized_expense_cannot_be_edited_directly()
    {
        var (owner, g, me, gran, _) = await ThreePersonGroupAsync();
        var e = await owner.AddEqualAsync(g.Id, 1000, me, [me, gran]);
        using (var scope = factory.Services.CreateScope())
        {
            // Stand-in for an expense confirmed from a table session (Task 4 creates these for real).
            var db = scope.ServiceProvider.GetRequiredService<Kitty.Ledger.Data.LedgerDbContext>();
            var row = await db.Expenses.SingleAsync(x => x.Id == e.Id, Ct);
            row.SplitMethod = Kitty.Ledger.Domain.Splits.SplitMethod.Itemized;
            await db.SaveChangesAsync(Ct);
        }

        var r = await owner.PutJsonAsync($"/groups/{g.Id}/expenses/{e.Id}",
            ExpenseData.Equal(e.Id, 1200, me, [me, gran], version: 1));
        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.Equal("edit_in_table", await r.ReadCodeAsync());

        var listed = (await owner.GetFromJsonAsync<ExpenseDto>($"/groups/{g.Id}/expenses/{e.Id}", ApiClientExtensions.Json, Ct))!;
        Assert.Equal("itemized", listed.Split.Method);
    }

    [Fact]
    public async Task Numeric_split_method_returns_400_not_500()
    {
        var (owner, g, me, gran, _) = await ThreePersonGroupAsync();
        var r = await owner.PostJsonAsync($"/groups/{g.Id}/expenses", new
        {
            id = Guid.NewGuid(), description = "Odd", category = "food", currency = "ZAR", amountMinor = 1000,
            occurredOn = "2026-11-15", payers = new[] { new { memberId = me, amountMinor = 1000 } },
            split = new { method = 99, participants = new[] { new { memberId = me }, new { memberId = gran } } },
        });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
    }

    [Fact]
    public async Task Unsupported_currency_returns_400()
    {
        var (owner, g, me, gran, _) = await ThreePersonGroupAsync();
        var r = await owner.PostJsonAsync($"/groups/{g.Id}/expenses", ExpenseData.Equal(Guid.NewGuid(), 500, me, [me, gran], currency: "XXX"));
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal("currency_unsupported", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Get_single_expense_and_404_once_deleted()
    {
        var (owner, g, me, gran, _) = await ThreePersonGroupAsync();
        var e = await owner.AddEqualAsync(g.Id, 500, me, [me, gran]);

        var got = (await owner.GetFromJsonAsync<ExpenseDto>($"/groups/{g.Id}/expenses/{e.Id}", ApiClientExtensions.Json, Ct))!;
        Assert.Equal(e.Id, got.Id);
        Assert.Equal(500, got.AmountMinor);

        (await owner.DeleteAsync($"/groups/{g.Id}/expenses/{e.Id}", key: null)).EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.NotFound, (await owner.GetAsync($"/groups/{g.Id}/expenses/{e.Id}", Ct)).StatusCode);
    }

    [Fact]
    public async Task Other_group_members_cannot_see_expenses()
    {
        var (owner, g, me, gran, _) = await ThreePersonGroupAsync();
        await owner.AddEqualAsync(g.Id, 500, me, [me, gran]);
        var r = await factory.NewUser().GetAsync($"/groups/{g.Id}/expenses", Ct);
        Assert.Equal(HttpStatusCode.NotFound, r.StatusCode);
    }
}
