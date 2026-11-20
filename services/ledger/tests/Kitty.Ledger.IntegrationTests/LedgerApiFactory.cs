using System.Net.Http.Headers;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.Protocols;
using Microsoft.IdentityModel.Protocols.OpenIdConnect;
using Testcontainers.Azurite;
using Testcontainers.PostgreSql;
using Testcontainers.Redpanda;

namespace Kitty.Ledger.IntegrationTests;

/// <summary>Boots the ledger against a throwaway Postgres (pgvector image, same as production), Redpanda (Kafka + schema registry) and Azurite (blob storage).</summary>
public sealed class LedgerApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("pgvector/pgvector:pg17")
        .WithDatabase("ledger")
        .Build();

    private readonly RedpandaContainer _redpanda = new RedpandaBuilder("docker.redpanda.com/redpandadata/redpanda:v26.2.6").Build();

    // Azurite lags the newest storage API versions the SDK sends, so skip its version check (as the Aspire host does).
    private readonly AzuriteContainer _azurite = new AzuriteBuilder("mcr.microsoft.com/azure-storage/azurite:3.37.0")
        .WithCommand("--skipApiVersionCheck").Build();

    public string BlobConnectionString => _azurite.GetConnectionString();
    public string KafkaBootstrap => _redpanda.GetBootstrapAddress();
    public string SchemaRegistryUrl => _redpanda.GetSchemaRegistryAddress();

    public async ValueTask InitializeAsync() => await Task.WhenAll(_postgres.StartAsync(), _redpanda.StartAsync(), _azurite.StartAsync());

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.UseSetting("ConnectionStrings:ledger", _postgres.GetConnectionString());
        builder.UseSetting("Ledger:MigrateOnStartup", "true");
        builder.UseSetting("ConnectionStrings:kafka", KafkaBootstrap);
        builder.UseSetting("Kafka:SchemaRegistryUrl", SchemaRegistryUrl);
        builder.UseSetting("ConnectionStrings:blobs", BlobConnectionString);
        builder.UseSetting("Auth:Authority", TestTokens.Issuer);
        builder.UseSetting("Auth:Audience", TestTokens.Audience);
        // Every test-server request has the same (unknown) client IP; the join limit has its own dedicated test.
        builder.UseSetting("Ledger:GuestJoinsPerMinute", "100000");
        builder.ConfigureTestServices(services =>
            services.PostConfigure<JwtBearerOptions>(JwtBearerDefaults.AuthenticationScheme, o =>
            {
                // Validate against the test key instead of fetching Keycloak's metadata.
                o.Configuration = new OpenIdConnectConfiguration { Issuer = TestTokens.Issuer };
                o.Configuration.SigningKeys.Add(TestTokens.SigningKey);
                // Without this the handler keeps trying (and timing out) to fetch the fake issuer's metadata.
                o.ConfigurationManager = new StaticConfigurationManager<OpenIdConnectConfiguration>(o.Configuration);
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
        await _redpanda.DisposeAsync();
        await _azurite.DisposeAsync();
    }
}

[CollectionDefinition(Name)]
public sealed class ApiCollection : ICollectionFixture<LedgerApiFactory>
{
    public const string Name = "api";
}
