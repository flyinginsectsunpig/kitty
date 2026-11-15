using System.Net.Http.Headers;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Testcontainers.PostgreSql;

namespace Kitty.Ledger.IntegrationTests;

/// <summary>Boots the ledger against a throwaway Postgres (pgvector image, same as production).</summary>
public sealed class LedgerApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("pgvector/pgvector:pg17")
        .WithDatabase("ledger")
        .Build();

    public async ValueTask InitializeAsync() => await _postgres.StartAsync();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.UseSetting("ConnectionStrings:ledger", _postgres.GetConnectionString());
        builder.UseSetting("Ledger:MigrateOnStartup", "true");
        builder.UseSetting("Auth:Authority", TestTokens.Issuer);
        builder.UseSetting("Auth:Audience", TestTokens.Audience);
        builder.ConfigureTestServices(services =>
            services.PostConfigure<JwtBearerOptions>(JwtBearerDefaults.AuthenticationScheme, o =>
            {
                // Validate against the test key instead of fetching Keycloak's metadata.
                o.Configuration = new OpenIdConnectConfiguration { Issuer = TestTokens.Issuer };
                o.Configuration.SigningKeys.Add(TestTokens.SigningKey);
                o.TokenValidationParameters.ValidIssuer = TestTokens.Issuer;
                o.TokenValidationParameters.IssuerSigningKey = TestTokens.SigningKey;
            }));
    }

    /// <summary>An HttpClient that sends a valid bearer token for the given Keycloak subject.</summary>
    public HttpClient CreateClientFor(string sub, string name = "Test User")
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Authorization =
            new AuthenticationHeaderValue("Bearer", TestTokens.For(sub, name, $"{sub}@example.com"));
        return client;
    }

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        await _postgres.DisposeAsync();
    }
}

[CollectionDefinition(Name)]
public sealed class ApiCollection : ICollectionFixture<LedgerApiFactory>
{
    public const string Name = "api";
}
