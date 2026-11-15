var builder = DistributedApplication.CreateBuilder(args);

var postgres = builder.AddPostgres("postgres")
    .WithImage("pgvector/pgvector")
    .WithImageTag("pg17"); // ephemeral in dev, like Keycloak: both reset on every run
var ledgerDb = postgres.AddDatabase("ledger-db", databaseName: "ledger");

// Catches Keycloak's verification emails locally (UI on the "ui" endpoint).
var mailpit = builder.AddContainer("mailpit", "axllent/mailpit", "v1.33.1")
    .WithHttpEndpoint(targetPort: 8025, name: "ui")
    .WithEndpoint(targetPort: 1025, name: "smtp");

var keycloak = builder.AddKeycloak("keycloak", port: 8180)
    .WithRealmImport("../../infra/keycloak")
    .WaitFor(mailpit);

var realmUrl = ReferenceExpression.Create($"{keycloak.GetEndpoint("http")}/realms/kitty");

var ledger = builder.AddProject<Projects.Kitty_Ledger>("ledger")
    .WithReference(ledgerDb, connectionName: "ledger")
    .WaitFor(ledgerDb)
    .WaitFor(keycloak)
    .WithEnvironment("Auth__Authority", realmUrl)
    .WithEnvironment("Auth__Audience", "kitty-ledger")
    .WithEnvironment("Ledger__MigrateOnStartup", "true");

// Generated once and kept in user secrets; signs the web session cookie.
var authSecret = builder.AddParameter("auth-secret",
    new GenerateParameterDefault { MinLength = 32, Special = false }, secret: true, persist: true);

// Uses node_modules from `corepack pnpm install` at the repo root; Aspire only runs the dev script.
builder.AddJavaScriptApp("web", "../../apps/web", "dev")
    .WithNpm(install: false)
    .WithHttpEndpoint(port: 3000, env: "PORT") // must match the Keycloak client redirect URI
    .WithReference(ledger)
    .WaitFor(ledger)
    .WithEnvironment("LEDGER_URL", ledger.GetEndpoint("http"))
    .WithEnvironment("AUTH_URL", "http://localhost:3000")
    .WithEnvironment("AUTH_SECRET", authSecret)
    .WithEnvironment("AUTH_KEYCLOAK_ID", "kitty-web")
    .WithEnvironment("AUTH_KEYCLOAK_SECRET", "dev-only-kitty-web-secret")
    .WithEnvironment("AUTH_KEYCLOAK_ISSUER", realmUrl);

builder.Build().Run();
