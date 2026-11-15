using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;

namespace Kitty.Ledger.IntegrationTests;

[Collection(ApiCollection.Name)]
public class IdempotencyTests(LedgerApiFactory factory)
{
    private sealed record MeDto(Guid Id, string DisplayName, string? Email);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private HttpClient NewUser() => factory.CreateClientFor($"sub-{Guid.NewGuid()}", "Original");

    [Fact]
    public async Task Missing_key_returns_400()
    {
        var c = NewUser();
        var r = await c.PatchAsJsonAsync("/me", new { displayName = "Nope" }, Ct);
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal("idempotency_key_required", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Same_key_same_body_replays_identical_response()
    {
        var c = NewUser();
        var first = await c.PatchJsonAsync("/me", new { displayName = "Alpha" }, key: "k-alpha");
        var firstBody = await first.Content.ReadAsStringAsync(Ct);

        (await c.PatchJsonAsync("/me", new { displayName = "Beta" })).EnsureSuccessStatusCode();

        var replay = await c.PatchJsonAsync("/me", new { displayName = "Alpha" }, key: "k-alpha");
        Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
        Assert.Equal(firstBody, await replay.Content.ReadAsStringAsync(Ct));

        // The replay did not run the handler again: the name is still Beta.
        Assert.Equal("Beta", (await c.GetFromJsonAsync<MeDto>("/me", Ct))!.DisplayName);
    }

    [Fact]
    public async Task Same_key_different_body_returns_422()
    {
        var c = NewUser();
        (await c.PatchJsonAsync("/me", new { displayName = "One" }, key: "k-reuse")).EnsureSuccessStatusCode();
        var r = await c.PatchJsonAsync("/me", new { displayName = "Two" }, key: "k-reuse");
        Assert.Equal(HttpStatusCode.UnprocessableEntity, r.StatusCode);
        Assert.Equal("idempotency_key_reused", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Keys_are_scoped_per_user()
    {
        var a = NewUser();
        var b = NewUser();
        (await a.PatchJsonAsync("/me", new { displayName = "Anna" }, key: "shared-key")).EnsureSuccessStatusCode();
        var r = await b.PatchJsonAsync("/me", new { displayName = "Ben" }, key: "shared-key");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        Assert.Equal("Ben", (await r.ReadAsync<MeDto>()).DisplayName);
    }

    [Fact]
    public async Task Validation_errors_are_replayed_too()
    {
        var c = NewUser();
        var first = await c.PatchJsonAsync("/me", new { displayName = "" }, key: "k-bad");
        var replay = await c.PatchJsonAsync("/me", new { displayName = "" }, key: "k-bad");
        Assert.Equal(HttpStatusCode.BadRequest, first.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, replay.StatusCode);
        Assert.Equal("validation_failed", await replay.ReadCodeAsync());
    }

    [Fact]
    public async Task Sixty_first_write_in_a_minute_returns_429()
    {
        // Same database, but a limit of 3 writes per minute instead of 60.
        using var limited = factory.WithWebHostBuilder(b => b.UseSetting("Ledger:WriteRateLimitPerMinute", "3"));
        var c = limited.CreateClient();
        c.DefaultRequestHeaders.Authorization = new("Bearer", TestTokens.For($"sub-{Guid.NewGuid()}", "Busy", "busy@example.com"));

        for (var i = 0; i < 3; i++)
            (await c.PatchJsonAsync("/me", new { displayName = $"N{i}" })).EnsureSuccessStatusCode();

        var r = await c.PatchJsonAsync("/me", new { displayName = "Too many" });
        Assert.Equal(HttpStatusCode.TooManyRequests, r.StatusCode);
        Assert.Equal("rate_limited", await r.ReadCodeAsync());
    }
}
