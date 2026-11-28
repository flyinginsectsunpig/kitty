var builder = DistributedApplication.CreateBuilder(args);

var postgres = builder.AddPostgres("postgres")
    .WithImage("pgvector/pgvector")
    .WithImageTag("pg17"); // ephemeral in dev, like Keycloak: both reset on every run
var ledgerDb = postgres.AddDatabase("ledger-db", databaseName: "ledger");

// SignalR backplane for live table updates (correct across ledger replicas).
var redis = builder.AddRedis("redis");

// Catches Keycloak's verification emails and pulse's notification emails locally (UI on the "ui" endpoint).
var mailpit = builder.AddContainer("mailpit", "axllent/mailpit", "v1.33.1")
    .WithHttpEndpoint(targetPort: 8025, name: "ui")
    .WithEndpoint(targetPort: 1025, name: "smtp");

// Plain HTTP locally (Aspire 17 turns on HTTPS by default): the issuer stays http://localhost:8180/realms/kitty,
// which the ledger, web and the phone (through adb reverse) all reach without trusting a dev certificate.
// WithoutHttpsCertificate is an evaluation API in Aspire 17; revisit when it's stable.
#pragma warning disable ASPIRECERTIFICATES001
var keycloak = builder.AddKeycloak("keycloak", port: 8180)
    .WithImageTag("26.6") // the version deploy/compose runs; newer images change sign-up (no password on the form)
    .WithoutHttpsCertificate()
#pragma warning restore ASPIRECERTIFICATES001
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
// Only wired in when set: Aspire 17 treats an empty parameter as missing and holds the ai service until one is entered.
var hasGeminiKey = !string.IsNullOrWhiteSpace(builder.Configuration["Parameters:gemini-api-key"]);

// Optional: push notifications need a Firebase service-account key file (see deploy/compose/RUNBOOK.md, "Notifications"):
// dotnet user-secrets set Parameters:fcm-credentials-path <path to the key file>. Without it pulse logs that push is off.
var fcmCredentialsPath = builder.Configuration["Parameters:fcm-credentials-path"];
var mailpitSmtp = mailpit.GetEndpoint("smtp");

// Exchange rates over gRPC (Go, run from source with `go run`). It creates its own "pulse" schema in the ledger database.
// No developer-certificate trust: Aspire would set SSL_CERT_DIR to its dev certificate alone, and Go then trusts only
// that, so pulse couldn't reach Frankfurter over HTTPS. pulse calls nothing that uses the dev certificate.
#pragma warning disable ASPIRECERTIFICATES001
var pulse = builder.AddExecutable("pulse", "go", "../../services/pulse", "run", "./cmd/pulse")
    .WithDeveloperCertificateTrust(false)
#pragma warning restore ASPIRECERTIFICATES001
    .WithHttpEndpoint(env: "PULSE_PORT", name: "grpc")
    .WithOtlpExporter(OtlpProtocol.HttpProtobuf) // the dashboard's OTLP/HTTP endpoint (pulse's exporter speaks HTTP)
    .WithEnvironment("PULSE_DATABASE_URL", ledgerDb.Resource.UriExpression)
    .WaitFor(ledgerDb)
    // Recurring expenses: follow the ledger's schedules on Kafka, add due periods over the ledger's internal gRPC port
    // with pulse's own Keycloak service token. pulse doesn't wait for the ledger (it retries), so there's no start-up cycle.
    .WithEnvironment("PULSE_KAFKA_BOOTSTRAP", kafkaBootstrap)
    .WithEnvironment("PULSE_LEDGER_GRPC", "localhost:" + LedgerGrpcPort.ToString(System.Globalization.CultureInfo.InvariantCulture))
    .WithEnvironment("PULSE_TOKEN_URL", ReferenceExpression.Create($"{keycloak.GetEndpoint("http")}/realms/kitty/protocol/openid-connect/token"))
    .WithEnvironment("PULSE_CLIENT_SECRET", "dev-only-kitty-pulse-secret")
    // Notifications: emails go to Mailpit (plain SMTP, no login); links in them open the local web app.
    .WithEnvironment("PULSE_SMTP_HOST", ReferenceExpression.Create($"{mailpitSmtp.Property(EndpointProperty.Host)}"))
    .WithEnvironment("PULSE_SMTP_PORT", ReferenceExpression.Create($"{mailpitSmtp.Property(EndpointProperty.Port)}"))
    .WithEnvironment("PULSE_SMTP_FROM", "Kitty <kitty@localhost>")
    .WithEnvironment("PULSE_WEB_URL", "http://localhost:3000")
    .WaitFor(mailpit)
    .WaitFor(redpanda)
    .WaitFor(keycloak);
if (!string.IsNullOrWhiteSpace(fcmCredentialsPath)) pulse.WithEnvironment("PULSE_FCM_CREDENTIALS", fcmCredentialsPath);

var ledger = builder.AddDotnetProject("ledger", "../../services/ledger/src/Kitty.Ledger/Kitty.Ledger.csproj")
    // pulse's gRPC port: plain HTTP/2, fixed and unproxied so the Host header carries the port the ledger checks.
    .WithHttpEndpoint(port: LedgerGrpcPort, targetPort: LedgerGrpcPort, name: "grpc", isProxied: false)
    .WithEnvironment("Ledger__GrpcPort", LedgerGrpcPort.ToString(System.Globalization.CultureInfo.InvariantCulture))
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
    .WithEnvironment("Blob__ConfigureCors", "true") // the browser (on :3000) uploads to Azurite cross-origin
    .WithEnvironment("Fx__Url", pulse.GetEndpoint("grpc"))
    .WaitFor(pulse);

// Reads receipt photos (local OCR, redaction, Gemini) and plain-language sentences. Uses the ai service's own uv
// environment. A fixed, unproxied port, so the phone (through `adb reverse`) reaches it at the same address as the web.
// Plain HTTP, like Keycloak: the phone can't trust Aspire's development certificate.
#pragma warning disable ASPIRECERTIFICATES001
var ai = builder.AddUvicornApp("ai", "../../services/ai", "kitty_ai.main:create_app")
    .WithoutHttpsCertificate()
#pragma warning restore ASPIRECERTIFICATES001
    .WithUv()
    .WithArgs("--factory")
    .WithOtlpExporter(OtlpProtocol.HttpProtobuf)
    .WithEndpoint("http", e => { e.Port = AiPort; e.IsProxied = false; })
    .WithEnvironment("AI_LEDGER_URL", ledger.GetEndpoint("http"))
    .WithEnvironment("AI_AUTH_ISSUER", realmUrl)
    .WithHttpHealthCheck("/health")
    .WithEnvironment("AI_KAFKA_BOOTSTRAP", kafkaBootstrap)
    .WithEnvironment("AI_SCHEMA_REGISTRY_URL", schemaRegistry)
    .WithEnvironment("AI_BLOB_CONNECTION_STRING", blobs.Resource.ConnectionStringExpression)
    .WithEnvironment("AI_POSTGRES_DSN", ledgerDb.Resource.ConnectionStringExpression)
    // MCP (phase 4d): ChatGPT, Claude and other assistants at http://localhost:5085/mcp. The secret matches the dev realm
    // import's kitty-mcp client; draft links open the web app.
    .WithEnvironment("AI_MCP_PUBLIC_URL", "http://localhost:" + AiPort + "/mcp")
    .WithEnvironment("AI_MCP_CLIENT_SECRET", "dev-only-kitty-mcp-secret")
    .WithEnvironment("AI_WEB_URL", "http://localhost:3000")
    .WaitFor(redpanda)
    .WaitFor(storage)
    .WaitFor(ledger); // the ledger creates the database
if (hasGeminiKey) ai.WithEnvironment("AI_GEMINI_API_KEY", builder.AddParameter("gemini-api-key", secret: true));

// Generated once and kept in user secrets; signs the web session cookie.
var authSecret = builder.AddParameter("auth-secret",
    new GenerateParameterDefault { MinLength = 32, Special = false }, secret: true, persist: true);

// Uses node_modules from `corepack pnpm install` at the repo root; Aspire only runs the dev script.
builder.AddJavaScriptApp("web", "../../apps/web", "dev")
    .WithNpm(install: false)
    .WithHttpEndpoint(port: 3000, env: "PORT") // must match the Keycloak client redirect URI
    .WithOtlpExporter(OtlpProtocol.HttpProtobuf)
    .WithReference(ledger)
    .WaitFor(ledger)
    .WithEnvironment("LEDGER_URL", ledger.GetEndpoint("http"))
    .WithEnvironment("LEDGER_PUBLIC_URL", ledger.GetEndpoint("http")) // the browser opens the live connection here
    .WithEnvironment("AUTH_URL", "http://localhost:3000")
    .WithEnvironment("AUTH_SECRET", authSecret)
    .WithEnvironment("AUTH_KEYCLOAK_ID", "kitty-web")
    .WithEnvironment("AUTH_KEYCLOAK_SECRET", "dev-only-kitty-web-secret")
    .WithEnvironment("AUTH_KEYCLOAK_ISSUER", realmUrl)
    .WithEnvironment("AI_URL", ai.GetEndpoint("http")); // plain-language entry, called from the server side

builder.Build().Run();

internal static partial class Program
{
    private const int LedgerGrpcPort = 5082;
    private const int AiPort = 5085;
}
