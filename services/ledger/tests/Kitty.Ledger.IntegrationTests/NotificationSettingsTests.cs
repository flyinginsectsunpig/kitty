using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Kitty.Contracts.Notify.V1;
using Kitty.Ledger.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Kitty.Ledger.IntegrationTests;

public sealed record NotificationSettingsDto(bool ExpensePush, bool ExpenseEmail, bool PaymentPush, bool PaymentEmail,
    bool WeeklyPush, bool WeeklyEmail, bool ReminderPush, bool ReminderEmail, bool EmailAvailable);

[Collection(ApiCollection.Name)]
public class NotificationSettingsTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private HttpClient User(string sub, string email, bool verified = true)
    {
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
            TestTokens.For(sub, "Someone", email, emailVerified: verified));
        return c;
    }

    /// <summary>The latest NotifySettingsChanged queued for a user (the outbox row, as pulse will read it).</summary>
    private async Task<NotifySettingsChanged?> LatestAsync(Guid userId)
    {
        using var scope = factory.Services.CreateScope();
        var payload = await scope.ServiceProvider.GetRequiredService<LedgerDbContext>().OutboxMessages
            .Where(m => m.Topic == "ledger.notify-settings" && m.Key == userId.ToString())
            .OrderByDescending(m => m.OccurredAt).ThenByDescending(m => m.Id).Select(m => m.Payload).FirstOrDefaultAsync(Ct);
        return payload is null ? null : NotifySettingsChanged.Parser.ParseFrom(payload);
    }

    [Fact]
    public async Task Defaults_are_push_on_for_expenses_and_payments_and_nothing_else()
    {
        var c = User($"sub-{Guid.NewGuid()}", "a@example.com");

        var s = (await c.GetFromJsonAsync<NotificationSettingsDto>("/me/notifications", ApiClientExtensions.Json, Ct))!;

        Assert.Equal(new NotificationSettingsDto(true, false, true, false, false, false, ReminderPush: true, ReminderEmail: false,
            EmailAvailable: true), s);
    }

    [Fact]
    public async Task A_new_user_is_published_with_the_defaults()
    {
        var c = User($"sub-{Guid.NewGuid()}", "new@example.com");
        var me = await c.MeAsync();

        var e = await LatestAsync(me.Id);

        Assert.NotNull(e);
        Assert.Equal(("new@example.com", true, false, true, false), (e.Email, e.ExpensePush, e.ExpenseEmail, e.PaymentPush, e.WeeklyPush));
    }

    [Fact]
    public async Task Saving_settings_publishes_the_full_state()
    {
        var c = User($"sub-{Guid.NewGuid()}", "b@example.com");
        var me = await c.MeAsync();
        (await c.PostJsonAsync("/me/devices", new { token = "tok-b1", platform = "android" })).EnsureSuccessStatusCode();

        var r = await c.PutJsonAsync("/me/notifications", new
        {
            expensePush = false, expenseEmail = true, paymentPush = true, paymentEmail = true, weeklyPush = true, weeklyEmail = false, reminderPush = false, reminderEmail = true,
        });

        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var e = (await LatestAsync(me.Id))!;
        Assert.Equal((false, true, true, true, true, false), (e.ExpensePush, e.ExpenseEmail, e.PaymentPush, e.PaymentEmail, e.WeeklyPush, e.WeeklyEmail));
        Assert.Equal((false, true), (e.ReminderPush, e.ReminderEmail));
        Assert.Equal(["tok-b1"], e.PushTokens);
        Assert.Equal("b@example.com", e.Email);
    }

    [Fact]
    public async Task Two_changes_racing_from_the_same_version_cannot_both_publish()
    {
        var c = User($"sub-{Guid.NewGuid()}", "race@example.com");
        var me = await c.MeAsync();
        using var first = factory.Services.CreateScope();
        using var second = factory.Services.CreateScope();
        var db1 = first.ServiceProvider.GetRequiredService<LedgerDbContext>();
        var db2 = second.ServiceProvider.GetRequiredService<LedgerDbContext>();
        var user1 = await db1.Users.SingleAsync(u => u.Id == me.Id, Ct);
        var user2 = await db2.Users.SingleAsync(u => u.Id == me.Id, Ct);
        // Both read the same version before either saves: a settings change and a new phone at the same moment.
        (await first.ServiceProvider.GetRequiredService<Kitty.Ledger.Features.Notifications.NotifySettingsPublisher>().SettingsAsync(me.Id, Ct)).ExpensePush = false;
        await second.ServiceProvider.GetRequiredService<Kitty.Ledger.Features.Notifications.NotifySettingsPublisher>().SettingsAsync(me.Id, Ct);
        await first.ServiceProvider.GetRequiredService<Kitty.Ledger.Features.Notifications.NotifySettingsPublisher>().QueueAsync(user1, Ct);
        await db1.SaveChangesAsync(Ct);

        db2.PushDevices.Add(new Kitty.Ledger.Data.Entities.PushDevice { Token = "tok-race", UserId = me.Id, Platform = "android" });
        await second.ServiceProvider.GetRequiredService<Kitty.Ledger.Features.Notifications.NotifySettingsPublisher>().QueueAsync(user2, Ct);

        await Assert.ThrowsAsync<DbUpdateConcurrencyException>(() => db2.SaveChangesAsync(Ct));
    }

    [Fact]
    public async Task Someone_from_before_notifications_opening_settings_twice_at_once_gets_them_both_times()
    {
        var c = User($"sub-{Guid.NewGuid()}", "early@example.com");
        var me = await c.MeAsync();
        using (var scope = factory.Services.CreateScope()) // as if they signed up before 3c: no settings row yet
        {
            var db = scope.ServiceProvider.GetRequiredService<LedgerDbContext>();
            await db.NotificationSettings.Where(s => s.UserId == me.Id).ExecuteDeleteAsync(Ct);
        }

        var results = await Task.WhenAll(Enumerable.Range(0, 6).Select(_ => c.GetAsync("/me/notifications", Ct)));

        Assert.All(results, r => Assert.Equal(HttpStatusCode.OK, r.StatusCode));
    }

    [Fact]
    public async Task A_settings_save_that_lost_a_race_is_a_version_conflict()
    {
        var c = User($"sub-{Guid.NewGuid()}", "race2@example.com");
        await c.GetAsync("/me/notifications", Ct);
        var body = new { expensePush = false, expenseEmail = false, paymentPush = true, paymentEmail = false, weeklyPush = false, weeklyEmail = false, reminderPush = false, reminderEmail = true };

        var results = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => c.PutJsonAsync("/me/notifications", body)));

        Assert.All(results, r => Assert.Contains(r.StatusCode, new[] { HttpStatusCode.OK, HttpStatusCode.Conflict }));
    }

    [Fact]
    public async Task A_device_registers_once_and_moves_between_users()
    {
        var first = User($"sub-{Guid.NewGuid()}", "c1@example.com");
        var second = User($"sub-{Guid.NewGuid()}", "c2@example.com");
        var (me1, me2) = (await first.MeAsync(), await second.MeAsync());
        var token = $"tok-{Guid.NewGuid()}";

        Assert.Equal(HttpStatusCode.NoContent, (await first.PostJsonAsync("/me/devices", new { token, platform = "android" })).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await first.PostJsonAsync("/me/devices", new { token, platform = "android" })).StatusCode);
        (await second.PostJsonAsync("/me/devices", new { token, platform = "android" })).EnsureSuccessStatusCode(); // shared phone

        Assert.Empty((await LatestAsync(me1.Id))!.PushTokens);
        Assert.Equal([token], (await LatestAsync(me2.Id))!.PushTokens);
    }

    [Fact]
    public async Task Forgetting_a_device_removes_it_from_the_published_tokens()
    {
        var c = User($"sub-{Guid.NewGuid()}", "d@example.com");
        var me = await c.MeAsync();
        (await c.PostJsonAsync("/me/devices", new { token = "tok-d1", platform = "android" })).EnsureSuccessStatusCode();

        Assert.Equal(HttpStatusCode.NoContent, (await c.PostJsonAsync("/me/devices/forget", new { token = "tok-d1" })).StatusCode);

        Assert.Empty((await LatestAsync(me.Id))!.PushTokens);
    }

    [Fact]
    public async Task An_unverified_email_is_not_published()
    {
        var c = User($"sub-{Guid.NewGuid()}", "e@example.com", verified: false);
        var me = await c.MeAsync();

        Assert.Equal("", (await LatestAsync(me.Id))!.Email);
        Assert.False((await c.GetFromJsonAsync<NotificationSettingsDto>("/me/notifications", ApiClientExtensions.Json, Ct))!.EmailAvailable);
    }

    [Fact]
    public async Task A_changed_email_in_the_token_is_refreshed_and_republished()
    {
        var sub = $"sub-{Guid.NewGuid()}";
        var me = await User(sub, "old@example.com").MeAsync();

        var refreshed = await User(sub, "new-address@example.com").MeAsync();

        Assert.Equal("new-address@example.com", refreshed.Email);
        Assert.Equal("new-address@example.com", (await LatestAsync(me.Id))!.Email);
    }

    [Fact]
    public async Task Device_tokens_are_never_in_urls()
    {
        var json = await factory.CreateClient().GetStringAsync("/openapi/v1.json", Ct);
        using var doc = JsonDocument.Parse(json);
        var paths = doc.RootElement.GetProperty("paths").EnumerateObject().Select(p => p.Name).ToList();

        Assert.Contains("/me/devices", paths);
        // (Invite links have their own {token} in the path; push tokens never do.)
        Assert.DoesNotContain(paths, p => p.StartsWith("/me/devices", StringComparison.Ordinal) && p.Contains('{'));
    }

    [Fact]
    public async Task Settings_change_reaches_kafka()
    {
        var c = User($"sub-{Guid.NewGuid()}", "k@example.com");
        var me = await c.MeAsync();
        (await c.PutJsonAsync("/me/notifications", new
        {
            expensePush = true, expenseEmail = true, paymentPush = true, paymentEmail = false, weeklyPush = false, weeklyEmail = false, reminderPush = true, reminderEmail = false,
        })).EnsureSuccessStatusCode();

        var events = await KafkaProbe.WaitForAsync<NotifySettingsChanged>(factory, "ledger.notify-settings",
            e => e.UserId == me.Id.ToString() && e.ExpenseEmail, count: 1);

        Assert.Equal(me.Id.ToString(), Assert.Single(events).Key);
    }
}
