using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Kitty.Contracts.Recurring.V1;
using Kitty.Ledger.Data;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;

namespace Kitty.Ledger.IntegrationTests;

public sealed record RecurringDto(Guid Id, string Description, string Currency, long AmountMinor, string Frequency,
    DateOnly StartsOn, DateOnly? EndsOn, bool Paused, DateOnly? NextDueOn, DateOnly? LastAddedOn, int Version);

public static class RecurringData
{
    public static object Monthly(Guid id, Guid payer, Guid[] participants, DateOnly startsOn, string frequency = "monthly",
        long amount = 1200000, string method = "equal", DateOnly? endsOn = null, int? version = null, string description = "Rent") => new
    {
        id, description, category = "rent", currency = "ZAR", amountMinor = amount,
        payers = new[] { new { memberId = payer, amountMinor = amount } },
        split = new { method, participants = participants.Select(m => new { memberId = m, value = (long?)null }) },
        frequency, startsOn = startsOn.ToString("yyyy-MM-dd"), endsOn = endsOn?.ToString("yyyy-MM-dd"), version,
    };
}

[Collection(ApiCollection.Name)]
public class RecurringTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    // A fixed "today" (UTC), so dates in the tests don't depend on when they run.
    private static readonly DateOnly Today = new(2026, 11, 24);

    private sealed record Env(WebApplicationFactory<Program> App, HttpClient Owner, Guid G, Guid Me, Guid Sam) : IDisposable
    {
        public void Dispose() => App.Dispose();
    }

    private async Task<Env> GroupAsync()
    {
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 11, 24, 10, 0, 0, TimeSpan.Zero));
        var app = factory.WithWebHostBuilder(b => b.ConfigureTestServices(s => s.AddSingleton<TimeProvider>(clock)));
        var owner = app.CreateClient();
        owner.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
            TestTokens.For($"sub-{Guid.NewGuid()}", "Owner", "owner@example.com"));
        var g = await owner.CreateGroupAsync();
        var sam = await owner.AddPlaceholderAsync(g.Id, "Sam");
        return new Env(app, owner, g.Id, g.Members[0].Id, sam.Id);
    }

    private static async Task<RecurringDto> CreatedAsync(HttpResponseMessage r)
    {
        Assert.Equal(HttpStatusCode.Created, r.StatusCode);
        return await r.ReadAsync<RecurringDto>();
    }

    private static async Task SetLastAddedAsync(Env env, Guid scheduleId, DateOnly period)
    {
        using var scope = env.App.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<LedgerDbContext>();
        await db.RecurringSchedules.Where(s => s.Id == scheduleId)
            .ExecuteUpdateAsync(u => u.SetProperty(s => s.LastAddedPeriod, period), Ct);
    }

    [Fact]
    public async Task Create_returns_the_schedule_with_its_next_due_date()
    {
        using var env = await GroupAsync();

        var s = await CreatedAsync(await env.Owner.PostJsonAsync($"/groups/{env.G}/recurring",
            RecurringData.Monthly(Guid.NewGuid(), env.Me, [env.Me, env.Sam], Today)));

        Assert.Equal(("monthly", Today, Today, false), (s.Frequency, s.StartsOn, s.NextDueOn!.Value, s.Paused));
        Assert.Null(s.LastAddedOn);
        var list = (await env.Owner.GetFromJsonAsync<List<RecurringDto>>($"/groups/{env.G}/recurring", ApiClientExtensions.Json, Ct))!;
        Assert.Equal(s.Id, Assert.Single(list).Id);
    }

    [Fact]
    public async Task Itemized_split_is_rejected()
    {
        using var env = await GroupAsync();
        var r = await env.Owner.PostJsonAsync($"/groups/{env.G}/recurring",
            RecurringData.Monthly(Guid.NewGuid(), env.Me, [env.Me], Today, method: "itemized"));
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
    }

    [Fact]
    public async Task Start_date_in_the_past_is_rejected()
    {
        using var env = await GroupAsync();
        var r = await env.Owner.PostJsonAsync($"/groups/{env.G}/recurring",
            RecurringData.Monthly(Guid.NewGuid(), env.Me, [env.Me], Today.AddDays(-1)));
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal("validation_failed", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Invalid_template_is_rejected_like_an_expense()
    {
        using var env = await GroupAsync();
        var body = new
        {
            id = Guid.NewGuid(), description = "Rent", category = "rent", currency = "ZAR", amountMinor = 1000L,
            payers = new[] { new { memberId = env.Me, amountMinor = 1000L } },
            split = new { method = "exact", participants = new[] { new { memberId = env.Me, value = (long?)400 } } },
            frequency = "monthly", startsOn = Today.ToString("yyyy-MM-dd"),
        };
        var r = await env.Owner.PostJsonAsync($"/groups/{env.G}/recurring", body);
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal("split_sum_mismatch", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Changing_frequency_after_periods_were_added_starts_at_the_next_cycle()
    {
        using var env = await GroupAsync();
        var id = Guid.NewGuid();
        var s = await CreatedAsync(await env.Owner.PostJsonAsync($"/groups/{env.G}/recurring",
            RecurringData.Monthly(id, env.Me, [env.Me, env.Sam], Today)));
        await SetLastAddedAsync(env, id, Today); // November's rent was added today

        var r = await env.Owner.PutJsonAsync($"/groups/{env.G}/recurring/{id}",
            RecurringData.Monthly(id, env.Me, [env.Me, env.Sam], Today, frequency: "weekly", version: s.Version));

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var weekly = await r.ReadAsync<RecurringDto>();
        // Weekly from the start date's weekday (Tuesday), but not before December: November is already paid.
        Assert.Equal(new DateOnly(2026, 12, 1), weekly.NextDueOn);
        using var scope = env.App.Services.CreateScope();
        var row = await scope.ServiceProvider.GetRequiredService<LedgerDbContext>().RecurringSchedules.SingleAsync(x => x.Id == id, Ct);
        Assert.Equal(new DateOnly(2026, 12, 1), row.NotBefore);
    }

    [Fact]
    public async Task Start_date_is_fixed_once_a_period_was_added()
    {
        using var env = await GroupAsync();
        var id = Guid.NewGuid();
        var s = await CreatedAsync(await env.Owner.PostJsonAsync($"/groups/{env.G}/recurring",
            RecurringData.Monthly(id, env.Me, [env.Me], Today)));
        await SetLastAddedAsync(env, id, Today);

        var r = await env.Owner.PutJsonAsync($"/groups/{env.G}/recurring/{id}",
            RecurringData.Monthly(id, env.Me, [env.Me], Today.AddDays(3), version: s.Version));

        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.Equal("schedule_started", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Resume_sets_not_before_to_today()
    {
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 11, 24, 10, 0, 0, TimeSpan.Zero));
        using var app = factory.WithWebHostBuilder(b => b.ConfigureTestServices(s => s.AddSingleton<TimeProvider>(clock)));
        var owner = app.CreateClient();
        owner.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
            TestTokens.For($"sub-{Guid.NewGuid()}", "Owner", "owner@example.com"));
        var g = await owner.CreateGroupAsync();
        var me = g.Members[0].Id;
        var id = Guid.NewGuid();
        await CreatedAsync(await owner.PostJsonAsync($"/groups/{g.Id}/recurring", RecurringData.Monthly(id, me, [me], Today, frequency: "weekly")));

        Assert.Equal(HttpStatusCode.OK, (await owner.PostJsonAsync($"/groups/{g.Id}/recurring/{id}/pause", new { })).StatusCode);
        clock.Advance(TimeSpan.FromDays(16)); // two weekly periods (1 Dec, 8 Dec) pass while paused
        var resumed = await (await owner.PostJsonAsync($"/groups/{g.Id}/recurring/{id}/resume", new { })).ReadAsync<RecurringDto>();

        Assert.False(resumed.Paused);
        Assert.Equal(new DateOnly(2026, 12, 15), resumed.NextDueOn);
        using var scope = app.Services.CreateScope();
        var row = await scope.ServiceProvider.GetRequiredService<LedgerDbContext>().RecurringSchedules.SingleAsync(x => x.Id == id, Ct);
        Assert.Equal(new DateOnly(2026, 12, 10), row.NotBefore);
    }

    [Fact]
    public async Task Every_change_queues_a_RecurringScheduleChanged_with_full_state()
    {
        using var env = await GroupAsync();
        var id = Guid.NewGuid();
        await CreatedAsync(await env.Owner.PostJsonAsync($"/groups/{env.G}/recurring",
            RecurringData.Monthly(id, env.Me, [env.Me], Today, endsOn: Today.AddMonths(6))));
        await env.Owner.PostJsonAsync($"/groups/{env.G}/recurring/{id}/pause", new { });
        Assert.Equal(HttpStatusCode.NoContent, (await env.Owner.DeleteAsync($"/groups/{env.G}/recurring/{id}", key: null)).StatusCode);

        using var scope = env.App.Services.CreateScope();
        var rows = await scope.ServiceProvider.GetRequiredService<LedgerDbContext>().OutboxMessages
            .Where(m => m.Topic == "ledger.recurring" && m.Key == id.ToString())
            .OrderBy(m => m.OccurredAt).ThenBy(m => m.Id).Select(m => m.Payload).ToListAsync(Ct);
        var events = rows.Select(RecurringScheduleChanged.Parser.ParseFrom).ToList();

        Assert.Equal(3, events.Count);
        var created = events[0];
        Assert.Equal((env.G.ToString(), RecurringScheduleChanged.Types.Frequency.Monthly, "2026-11-24", "2026-11-24", "2027-05-24"),
            (created.GroupId, created.Frequency, created.StartsOn, created.NotBefore, created.EndsOn));
        Assert.True(events[1].Paused);
        Assert.True(events[2].Deleted);
        Assert.True(events[0].Version < events[1].Version && events[1].Version < events[2].Version);
    }

    [Fact]
    public async Task A_schedule_change_reaches_kafka_keyed_by_schedule()
    {
        // Through the outbox relay and the schema registry, as pulse reads it (not just the outbox row).
        var owner = factory.NewUser("Owner");
        var g = await owner.CreateGroupAsync();
        var me = g.Members[0].Id;
        var id = Guid.NewGuid();
        var start = DateOnly.FromDateTime(DateTime.UtcNow);
        (await owner.PostJsonAsync($"/groups/{g.Id}/recurring", RecurringData.Monthly(id, me, [me], start))).EnsureSuccessStatusCode();

        var events = await KafkaProbe.WaitForAsync<RecurringScheduleChanged>(factory, "ledger.recurring", e => e.ScheduleId == id.ToString());

        var (key, e) = Assert.Single(events);
        Assert.Equal(id.ToString(), key);
        Assert.Equal((g.Id.ToString(), RecurringScheduleChanged.Types.Frequency.Monthly), (e.GroupId, e.Frequency));
    }

    [Fact]
    public async Task Non_member_gets_404()
    {
        using var env = await GroupAsync();
        var stranger = factory.NewUser("Stranger");
        Assert.Equal(HttpStatusCode.NotFound, (await stranger.GetAsync($"/groups/{env.G}/recurring", Ct)).StatusCode);
    }

    [Fact]
    public async Task Service_token_is_refused_on_rest()
    {
        var pulse = factory.CreateClient();
        pulse.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", TestTokens.ForService("kitty-pulse"));

        var r = await pulse.GetAsync("/me", Ct);

        Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
        Assert.Equal("service_token_not_allowed", await r.ReadCodeAsync());
    }
}
