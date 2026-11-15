using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;

namespace Kitty.Ledger.IntegrationTests;

[Collection(ApiCollection.Name)]
public class MeTests(LedgerApiFactory factory)
{

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Me_without_token_returns_401() =>
        Assert.Equal(HttpStatusCode.Unauthorized, (await factory.CreateClient().GetAsync("/me", Ct)).StatusCode);

    [Fact]
    public async Task Me_creates_user_on_first_call_and_is_stable()
    {
        var c = factory.CreateClientFor($"sub-{Guid.NewGuid()}", "Thandi");
        var first = await c.GetFromJsonAsync<MeDto>("/me", Ct);
        var second = await c.GetFromJsonAsync<MeDto>("/me", Ct);
        Assert.Equal("Thandi", first!.DisplayName);
        Assert.Equal(first.Id, second!.Id);
    }

    [Fact]
    public async Task Token_with_wrong_audience_is_rejected()
    {
        var c = factory.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer",
            TestTokens.For($"sub-{Guid.NewGuid()}", "Eve", "eve@example.com", audience: "some-other-api"));
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.GetAsync("/me", Ct)).StatusCode);
    }

    [Fact]
    public async Task Health_is_mapped_outside_development() =>
        Assert.Equal(HttpStatusCode.OK, (await factory.CreateClient().GetAsync("/health", Ct)).StatusCode);
}
