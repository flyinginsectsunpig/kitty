var builder = DistributedApplication.CreateBuilder(args);

var postgres = builder.AddPostgres("postgres")
    .WithImage("pgvector/pgvector")
    .WithImageTag("pg17"); // ephemeral in dev, like Keycloak: both reset on every run
var ledgerDb = postgres.AddDatabase("ledger-db", databaseName: "ledger");

// SignalR backplane for live table updates (correct across ledger replicas).
var redis = builder.AddRedis("redis");

// Catches Keycloak's verification emails locally (UI on the "ui" endpoint).
var mailpit = builder.AddContainer("mailpit", "axllent/mailpit", "v1.33.1")
    .WithHttpEndpoint(targetPort: 8025, name: "ui")
    .WithEndpoint(targetPort: 1025, name: "smtp");

var keycloak = builder.AddKeycloak("keycloak", port: 8180)
    .WithRealmImport("../../infra/keycloak")
    .WaitFor(mailpit);

var realmUrl = ReferenceExpression.Create($"{keycloak.GetEndpoint("http")}/realms/kitty");

// Kafka API + schema registry: receipt scans to the ai service and results back, plus ledger events.
// Fixed, unproxied host ports, so the address Redpanda advertises works for the ledger and ai on this machine.
var redpanda = builder.AddContainer("redpanda", "docker.redpanda.com/redpandadata/redpanda", "v26.2.6")
    .WithArgs("redpanda", "start", "--mode", "dev-container", "--smp", "1",
        "--kafka-addr", "internal://0.0.0.0:9092,external://0.0.0.0:19092",
        "--advertise-kafka-addr", "internal://redpanda:9092,external://localhost:19092",
        "--schema-registry-addr", "internal://0.0.0.0:8081,external://0.0.0.0:18081")
    .WithEndpoint(port: 19092, targetPort: 19092, name: "kafka", isProxied: false)
    .WithHttpEndpoint(port: 18081, targetPort: 18081, name: "schema-registry", isProxied: false);
const string kafkaBootstrap = "localhost:19092";
const string schemaRegistry = "http://localhost:18081";

// Receipt photos (Azurite locally).
// Fixed blob port, so the phone app (through `adb reverse`) can upload to the same address the ledger signs.
var storage = builder.AddAzureStorage("storage").RunAsEmulator(e => e.WithImageTag("3.37.0").WithBlobPort(10000));
var blobs = storage.AddBlobs("blobs");

// Optional: without a key, scans fail fast with "type the items" (dotnet user-secrets set Parameters:gemini-api-key ...).
var geminiKey = builder.AddParameter("gemini-api-key", "", secret: true);

var ledger = builder.AddProject<Projects.Kitty_Ledger>("ledger")
    .WithReference(ledgerDb, connectionName: "ledger")
    .WaitFor(ledgerDb)
    .WaitFor(keycloak)
    .WithEnvironment("Auth__Authority", realmUrl)
    .WithEnvironment("Auth__Audience", "kitty-ledger")
    .WithEnvironment("Ledger__MigrateOnStartup", "true")
    .WithReference(redis)
    .WaitFor(redis)
    .WithEnvironment("Ledger__WebOrigins", "http://localhost:3000")
    .WithEnvironment("ConnectionStrings__kafka", kafkaBootstrap)
    .WithEnvironment("Kafka__SchemaRegistryUrl", schemaRegistry)
    .WaitFor(redpanda)
    .WithReference(blobs)
    .WaitFor(storage)
    .WithEnvironment("Blob__ConfigureCors", "true"); // the browser (on :3000) uploads to Azurite cross-origin

// Reads receipt photos (local OCR, redaction, Gemini). Uses the ai service's own uv environment.
builder.AddUvicornApp("ai", "../../services/ai", "kitty_ai.main:create_app")
    .WithUv()
    .WithArgs("--factory")
    .WithHttpHealthCheck("/health")
    .WithEnvironment("AI_KAFKA_BOOTSTRAP", kafkaBootstrap)
    .WithEnvironment("AI_SCHEMA_REGISTRY_URL", schemaRegistry)
    .WithEnvironment("AI_BLOB_CONNECTION_STRING", blobs.Resource.ConnectionStringExpression)
    .WithEnvironment("AI_POSTGRES_DSN", ledgerDb.Resource.ConnectionStringExpression)
    .WithEnvironment("AI_GEMINI_API_KEY", geminiKey)
    .WaitFor(redpanda)
    .WaitFor(storage)
    .WaitFor(ledger); // the ledger creates the database

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
    .WithEnvironment("LEDGER_PUBLIC_URL", ledger.GetEndpoint("http")) // the browser opens the live connection here
    .WithEnvironment("AUTH_URL", "http://localhost:3000")
    .WithEnvironment("AUTH_SECRET", authSecret)
    .WithEnvironment("AUTH_KEYCLOAK_ID", "kitty-web")
    .WithEnvironment("AUTH_KEYCLOAK_SECRET", "dev-only-kitty-web-secret")
    .WithEnvironment("AUTH_KEYCLOAK_ISSUER", realmUrl);

builder.Build().Run();
