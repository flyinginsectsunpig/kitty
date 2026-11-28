using System.Diagnostics;
using Kitty.Contracts.Events.V1;
using Kitty.Ledger.Data;
using Kitty.Ledger.Infrastructure.Messaging;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.UnitTests;

/// <summary>The outbox keeps the request's trace with each queued message, so its Kafka hop joins the same trace.</summary>
public class OutboxTraceTests
{
    // Add only tracks the entity; nothing connects to this database.
    private static LedgerDbContext NewDb() =>
        new(new DbContextOptionsBuilder<LedgerDbContext>().UseNpgsql("Host=unused;Database=unused").Options);

    private static ExpenseChanged AnEvent() => new() { EventId = "e1", GroupId = "g1", ExpenseId = "x1" };

    [Fact]
    public void Add_records_the_current_trace()
    {
        using var db = NewDb();
        using var activity = new Activity("test").SetIdFormat(ActivityIdFormat.W3C).Start();

        new Outbox(db, TimeProvider.System).Add("ledger.events", "g1", AnEvent());

        var row = Assert.Single(db.OutboxMessages.Local);
        Assert.Equal(activity.Id, row.TraceParent);
        Assert.StartsWith("00-", row.TraceParent); // W3C traceparent: 00-<trace id>-<span id>-<flags>
    }

    [Fact]
    public void Add_outside_any_trace_leaves_it_empty()
    {
        using var db = NewDb();
        Activity.Current = null;

        new Outbox(db, TimeProvider.System).Add("ledger.events", "g1", AnEvent());

        Assert.Null(Assert.Single(db.OutboxMessages.Local).TraceParent);
    }
}
