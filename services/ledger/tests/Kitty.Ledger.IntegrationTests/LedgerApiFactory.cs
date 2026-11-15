using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
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
