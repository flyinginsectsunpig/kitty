var builder = DistributedApplication.CreateBuilder(args);

var postgres = builder.AddPostgres("postgres")
    .WithImage("pgvector/pgvector")
    .WithImageTag("pg17")
    .WithDataVolume("kitty-pgdata");
var ledgerDb = postgres.AddDatabase("ledger-db", databaseName: "ledger");

var keycloak = builder.AddKeycloak("keycloak", port: 8180)
    .WithDataVolume("kitty-keycloak")
    .WithRealmImport("../../infra/keycloak");

var realmUrl = ReferenceExpression.Create($"{keycloak.GetEndpoint("http")}/realms/kitty");

var ledger = builder.AddProject<Projects.Kitty_Ledger>("ledger")
    .WithReference(ledgerDb, connectionName: "ledger")
    .WaitFor(ledgerDb)
    .WaitFor(keycloak)
    .WithEnvironment("Auth__Authority", realmUrl)
    .WithEnvironment("Auth__Audience", "kitty-ledger")
    .WithEnvironment("Ledger__MigrateOnStartup", "true");

builder.Build().Run();
