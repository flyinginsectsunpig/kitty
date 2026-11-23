using System.Net;
using Kitty.Contracts.Events.V1;
using Kitty.Ledger.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Kitty.Ledger.IntegrationTests;

[Collection(ApiCollection.Name)]
public class OutboxTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Expense_create_publishes_ExpenseChanged()
    {
        var alice = factory.NewUser("Alice");
        var g = await alice.CreateGroupAsync();
        var me = g.Members[0].Id;
        var expense = await alice.AddEqualAsync(g.Id, 30000, me, [me]);

        var events = await KafkaProbe.WaitForAsync<ExpenseChanged>(factory, "ledger.events", e => e.ExpenseId == expense.Id.ToString());

        var (key, e) = Assert.Single(events);
        Assert.Equal(g.Id.ToString(), key);
        Assert.Equal((g.Id.ToString(), ExpenseChanged.Types.Change.Created), (e.GroupId, e.Change));
        Assert.True(Guid.TryParse(e.EventId, out _));
        await WaitUntilSentAsync(expense.Id);
    }

    [Fact]
    public async Task Failed_write_leaves_no_outbox_row()
    {
        var alice = factory.NewUser("Alice");
        var g = await alice.CreateGroupAsync();
        var me = g.Members[0].Id;
        var outsider = (await factory.NewUser("Bob").CreateGroupAsync()).Members[0].Id;
        var id = Guid.NewGuid();

        var r = await alice.PostJsonAsync($"/groups/{g.Id}/expenses", ExpenseData.Equal(id, 1000, me, [me, outsider]));

        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal(0, await RowsForAsync(id));
    }

    [Fact]
    public async Task Events_for_one_group_keep_their_order()
    {
        var alice = factory.NewUser("Alice");
        var g = await alice.CreateGroupAsync();
        var me = g.Members[0].Id;
        var expense = await alice.AddEqualAsync(g.Id, 30000, me, [me]);
        (await alice.PutJsonAsync($"/groups/{g.Id}/expenses/{expense.Id}",
            ExpenseData.Equal(expense.Id, 45000, me, [me], version: expense.Version))).EnsureSuccessStatusCode();
        (await alice.DeleteAsync($"/groups/{g.Id}/expenses/{expense.Id}", key: null)).EnsureSuccessStatusCode();

        var events = await KafkaProbe.WaitForAsync<ExpenseChanged>(factory, "ledger.events",
            e => e.ExpenseId == expense.Id.ToString(), count: 3);

        Assert.Equal([ExpenseChanged.Types.Change.Created, ExpenseChanged.Types.Change.Updated, ExpenseChanged.Types.Change.Deleted],
            events.Select(x => x.Value.Change));
    }

    private async Task<int> RowsForAsync(Guid expenseId)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<LedgerDbContext>();
        // The key is the group id, so look inside the payload for the expense id.
        var rows = await db.OutboxMessages.Where(m => m.Topic == "ledger.events").Select(m => m.Payload).ToListAsync(Ct);
        return rows.Count(p => ExpenseChanged.Parser.ParseFrom(p).ExpenseId == expenseId.ToString());
    }

    private async Task WaitUntilSentAsync(Guid expenseId)
    {
        for (var i = 0; i < 40; i++)
        {
            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<LedgerDbContext>();
            var unsent = await db.OutboxMessages.Where(m => m.SentAt == null && m.Topic == "ledger.events").Select(m => m.Payload).ToListAsync(Ct);
            if (!unsent.Any(p => ExpenseChanged.Parser.ParseFrom(p).ExpenseId == expenseId.ToString())) return;
            await Task.Delay(250, Ct);
        }
        Assert.Fail("the outbox row was never marked sent");
    }
}
