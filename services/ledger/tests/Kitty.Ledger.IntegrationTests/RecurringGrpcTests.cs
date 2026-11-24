using System.Net.Http.Headers;
using System.Net.Http.Json;
using Grpc.Core;
using Grpc.Core.Interceptors;
using Grpc.Net.Client;
using Kitty.Contracts.Ledger.V1;
using Kitty.Ledger.Data;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;

namespace Kitty.Ledger.IntegrationTests;

[Collection(ApiCollection.Name)]
public class RecurringGrpcTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private static readonly DateOnly Today = new(2026, 11, 24);

    private sealed class Env(WebApplicationFactory<Program> app, HttpClient owner, Guid g, Guid me, Guid sam) : IDisposable
    {
        public WebApplicationFactory<Program> App => app;
        public HttpClient Owner => owner;
        public Guid G => g;
        public Guid Me => me;
        public Guid Sam => sam;
        public void Dispose() => app.Dispose();

        /// <summary>pulse's view: the internal gRPC port, with a client-credentials token.</summary>
        public RecurringService.RecurringServiceClient Pulse(string token)
        {
            var channel = GrpcChannel.ForAddress("http://localhost:8082", new GrpcChannelOptions { HttpHandler = app.Server.CreateHandler() });
            return new RecurringService.RecurringServiceClient(channel.Intercept(m => { m.Add("authorization", $"Bearer {token}"); return m; }));
        }

        public LedgerDbContext Db(IServiceScope scope) => scope.ServiceProvider.GetRequiredService<LedgerDbContext>();
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

    private static async Task<Guid> ScheduleAsync(Env env, string frequency = "monthly", string currency = "ZAR", long amount = 1200000,
        DateOnly? endsOn = null)
    {
        var id = Guid.NewGuid();
        var body = new
        {
            id, description = "Rent", category = "rent", currency, amountMinor = amount,
            payers = new[] { new { memberId = env.Me, amountMinor = amount } },
            split = new { method = "equal", participants = new[] { env.Me, env.Sam }.Select(m => new { memberId = m, value = (long?)null }) },
            frequency, startsOn = Today.ToString("yyyy-MM-dd"), endsOn = endsOn?.ToString("yyyy-MM-dd"),
        };
        (await env.Owner.PostJsonAsync($"/groups/{env.G}/recurring", body)).EnsureSuccessStatusCode();
        return id;
    }

    private static Task<AddOccurrenceResponse> AddAsync(Env env, Guid scheduleId, DateOnly period) =>
        env.Pulse(TestTokens.ForService("kitty-pulse"))
            .AddOccurrenceAsync(new AddOccurrenceRequest { ScheduleId = scheduleId.ToString(), Period = period.ToString("yyyy-MM-dd") },
                cancellationToken: Ct).ResponseAsync;

    [Fact]
    public async Task Adds_the_period_as_an_expense_dated_that_day()
    {
        using var env = await GroupAsync();
        var id = await ScheduleAsync(env);

        var res = await AddAsync(env, id, Today);

        Assert.False(res.AlreadyAdded);
        var e = (await env.Owner.GetFromJsonAsync<ExpenseFxDto>($"/groups/{env.G}/expenses/{res.ExpenseId}", ApiClientExtensions.Json, Ct))!;
        Assert.Equal(("Rent", Today, 1200000L), (e.Description, e.OccurredOn, e.AmountMinor));
    }

    [Fact]
    public async Task Adding_the_same_period_twice_returns_the_same_expense()
    {
        using var env = await GroupAsync();
        var id = await ScheduleAsync(env);

        var first = await AddAsync(env, id, Today);
        var second = await AddAsync(env, id, Today);

        Assert.True(second.AlreadyAdded);
        Assert.Equal(first.ExpenseId, second.ExpenseId);
        using var scope = env.App.Services.CreateScope();
        Assert.Equal(1, await env.Db(scope).Expenses.CountAsync(x => x.RecurringScheduleId == id, Ct));
    }

    [Fact]
    public async Task Recurring_periods_tell_everyone_involved_including_the_creator()
    {
        using var env = await GroupAsync();
        var id = await ScheduleAsync(env); // Rent R 12 000,00, split equally between the owner and Sam (a placeholder)
        var owner = await env.Owner.MeAsync();

        await AddAsync(env, id, Today);

        using var scope = env.App.Services.CreateScope();
        var payloads = await env.Db(scope).OutboxMessages.Where(m => m.Topic == "notifications.requested").Select(m => m.Payload).ToListAsync(Ct);
        var r = Assert.Single(payloads.Select(Kitty.Contracts.Notify.V1.NotificationRequested.Parser.ParseFrom),
            n => n.GroupId == env.G.ToString());
        Assert.Equal(owner.Id.ToString(), r.UserId);
        Assert.Equal("Rent was added · your share R 6 000,00", r.Body);
    }

    [Fact]
    public async Task Two_pulse_instances_adding_the_same_period_at_once_make_one_expense()
    {
        using var env = await GroupAsync();
        var id = await ScheduleAsync(env);

        var results = await Task.WhenAll(Enumerable.Range(0, 6).Select(_ => AddAsync(env, id, Today)));

        Assert.Single(results.Select(r => r.ExpenseId).Distinct());
        Assert.Equal(5, results.Count(r => r.AlreadyAdded));
        using var scope = env.App.Services.CreateScope();
        Assert.Equal(1, await env.Db(scope).Expenses.CountAsync(x => x.RecurringScheduleId == id, Ct));
    }

    [Fact]
    public async Task A_deleted_added_expense_is_not_added_again()
    {
        using var env = await GroupAsync();
        var id = await ScheduleAsync(env);
        var first = await AddAsync(env, id, Today);
        (await env.Owner.DeleteAsync($"/groups/{env.G}/expenses/{first.ExpenseId}", key: null)).EnsureSuccessStatusCode();

        var again = await AddAsync(env, id, Today);

        Assert.True(again.AlreadyAdded);
        Assert.Equal(first.ExpenseId, again.ExpenseId);
    }

    [Fact]
    public async Task A_user_token_is_permission_denied()
    {
        using var env = await GroupAsync();
        var id = await ScheduleAsync(env);
        var asUser = env.Pulse(TestTokens.For($"sub-{Guid.NewGuid()}", "Mallory", "m@example.com"));

        var e = await Assert.ThrowsAsync<RpcException>(() => asUser.AddOccurrenceAsync(
            new AddOccurrenceRequest { ScheduleId = id.ToString(), Period = "2026-11-24" }, cancellationToken: Ct).ResponseAsync);

        Assert.Equal(StatusCode.PermissionDenied, e.StatusCode);
    }

    [Theory]
    [InlineData("paused")]
    [InlineData("deleted")]
    [InlineData("ended")]
    [InlineData("off-rule")]
    [InlineData("before-not-before")]
    public async Task Paused_deleted_ended_or_off_rule_is_failed_precondition(string why)
    {
        using var env = await GroupAsync();
        var id = await ScheduleAsync(env, endsOn: why == "ended" ? Today : null);
        var period = Today;
        switch (why)
        {
            case "paused": (await env.Owner.PostJsonAsync($"/groups/{env.G}/recurring/{id}/pause", new { })).EnsureSuccessStatusCode(); break;
            case "deleted": (await env.Owner.DeleteAsync($"/groups/{env.G}/recurring/{id}", key: null)).EnsureSuccessStatusCode(); break;
            case "ended": period = Today.AddMonths(1); break;
            case "off-rule": period = Today.AddDays(1); break;
            case "before-not-before": period = Today.AddMonths(-1); break;
        }

        var e = await Assert.ThrowsAsync<RpcException>(() => AddAsync(env, id, period));

        Assert.Equal(StatusCode.FailedPrecondition, e.StatusCode);
    }

    [Fact]
    public async Task Unknown_schedule_is_not_found()
    {
        using var env = await GroupAsync();
        var e = await Assert.ThrowsAsync<RpcException>(() => AddAsync(env, Guid.NewGuid(), Today));
        Assert.Equal(StatusCode.NotFound, e.StatusCode);
    }

    [Fact]
    public async Task A_period_after_today_is_not_due_yet()
    {
        using var env = await GroupAsync();
        var id = await ScheduleAsync(env, frequency: "weekly");

        var e = await Assert.ThrowsAsync<RpcException>(() => AddAsync(env, id, Today.AddDays(7)));

        Assert.Equal((StatusCode.Unavailable, "not due yet"), (e.StatusCode, e.Status.Detail));
    }

    [Fact]
    public async Task Foreign_period_gets_that_days_rate()
    {
        factory.Fx.Set("EUR", "ZAR", Today, 19.1987m);
        using var env = await GroupAsync();
        var id = await ScheduleAsync(env, currency: "EUR", amount: 4000);

        var res = await AddAsync(env, id, Today);

        var e = (await env.Owner.GetFromJsonAsync<ExpenseFxDto>($"/groups/{env.G}/expenses/{res.ExpenseId}", ApiClientExtensions.Json, Ct))!;
        Assert.Equal(("19.1987", "ecb", 76795L), (e.FxRate, e.FxRateSource, e.ConvertedAmountMinor!.Value));
    }

    [Fact]
    public async Task Too_large_to_convert_is_saved_without_rate()
    {
        factory.Fx.Set("EUR", "ZAR", Today, 1000m);
        using var env = await GroupAsync();
        var id = await ScheduleAsync(env, currency: "EUR", amount: 9_000_000_000);

        var res = await AddAsync(env, id, Today);

        var e = (await env.Owner.GetFromJsonAsync<ExpenseFxDto>($"/groups/{env.G}/expenses/{res.ExpenseId}", ApiClientExtensions.Json, Ct))!;
        Assert.Null(e.FxRate);
        Assert.Null(e.ConvertedAmountMinor);
    }

    [Fact]
    public async Task Records_last_added_period()
    {
        using var env = await GroupAsync();
        var id = await ScheduleAsync(env);

        await AddAsync(env, id, Today);

        var s = (await env.Owner.GetFromJsonAsync<RecurringDto>($"/groups/{env.G}/recurring/{id}", ApiClientExtensions.Json, Ct))!;
        Assert.Equal(Today, s.LastAddedOn);
        Assert.Equal(new DateOnly(2026, 12, 24), s.NextDueOn);
    }
}
