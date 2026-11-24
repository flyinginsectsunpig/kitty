using Kitty.Ledger.Data;
using System.Text.Json;
using System.Text.Json.Serialization;
using Kitty.Ledger.Features;
using Kitty.Ledger.Features.Activity;
using Kitty.Ledger.Features.Balances;
using Kitty.Ledger.Features.Expenses;
using Kitty.Ledger.Features.Fx;
using Kitty.Ledger.Features.Notifications;
using Kitty.Ledger.Features.Recurring;
using Kitty.Ledger.Features.Settlements;
using Kitty.Ledger.Features.Table;
using Kitty.Ledger.Features.Groups;
using Kitty.Ledger.Features.Invites;
using Kitty.Ledger.Features.Me;
using Kitty.Ledger.Infrastructure.Audit;
using Kitty.Ledger.Infrastructure.Auth;
using Kitty.Ledger.Infrastructure.Idempotency;
using Kitty.Ledger.Infrastructure.Messaging;
using Kitty.Ledger.Infrastructure.Blob;
using Kitty.Ledger.Infrastructure.Fx;
using Kitty.Ledger.Infrastructure.RateLimiting;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();
builder.Services.AddProblemDetails();
builder.Services.ConfigureHttpJsonOptions(o =>
{
    // Names only: a numeric value like 99 must not bind to an undefined enum member.
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false));
    // Money is integers; never accept or advertise numbers-as-strings.
    o.SerializerOptions.NumberHandling = JsonNumberHandling.Strict;
});
builder.Services.AddOpenApi();
builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddDbContext<LedgerDbContext>((sp, options) =>
    options.UseNpgsql(sp.GetRequiredService<IConfiguration>().GetConnectionString("ledger")
        ?? throw new InvalidOperationException("Connection string 'ledger' is not configured.")));
builder.Services.AddLedgerAuth(builder.Configuration, builder.Environment);
builder.Services.AddWriteRateLimiting(builder.Configuration);
if (builder.Configuration.GetValue<bool>("Ledger:TrustForwardedHeaders"))
{
    // Only enable where the ledger is reachable solely through the reverse proxy (deploy/compose: Caddy),
    // so per-IP limits see the real client address.
    builder.Services.Configure<ForwardedHeadersOptions>(o =>
    {
        o.ForwardedHeaders = Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedFor | Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedProto;
        o.KnownIPNetworks.Clear();
        o.KnownProxies.Clear();
    });
}
builder.Services.AddHostedService<IdempotencyCleanup>();
builder.Services.AddScoped<AuditWriter>();
builder.Services.AddScoped<Outbox>();
builder.Services.AddScoped<Kitty.Ledger.Features.Scans.ScanResultHandler>();
builder.Services.AddSingleton(new Azure.Storage.Blobs.BlobServiceClient(builder.Configuration.GetConnectionString("blobs")
    ?? throw new InvalidOperationException("Connection string 'blobs' (receipt photo storage) is not configured.")));
builder.Services.AddSingleton<ReceiptBlobs>();
builder.Services.AddHostedService<ReceiptBlobsSetup>();
builder.Services.AddHostedService<Kitty.Ledger.Features.Scans.ScanCleanup>();
if (KafkaOptions.From(builder.Configuration) is { } kafka)
{
    builder.Services.AddSingleton(kafka);
    builder.Services.AddSingleton<Confluent.SchemaRegistry.ISchemaRegistryClient>(_ =>
        new Confluent.SchemaRegistry.CachedSchemaRegistryClient(new Confluent.SchemaRegistry.SchemaRegistryConfig { Url = kafka.SchemaRegistryUrl }));
    builder.Services.AddSingleton<EventSerializers>();
    builder.Services.AddHostedService<OutboxRelay>();
    builder.Services.AddHostedService<InboxConsumer>();
}
builder.Services.AddFxRates(builder.Configuration);
builder.Services.AddScoped<ExpenseRates>();
builder.Services.AddScoped<NotifySettingsPublisher>();
builder.Services.AddHostedService<NotifySettingsBackfill>();

// pulse adds recurring periods over gRPC: plain HTTP/2 on its own port (not routed by Caddy), pulse's token only.
var grpcPort = builder.Configuration.GetValue("Ledger:GrpcPort", 8082);
builder.Services.AddGrpc();
builder.Services.AddAuthorizationBuilder().AddPolicy("pulse", p => p.RequireClaim("azp", ServiceTokenGuard.PulseClientId));
builder.WebHost.ConfigureKestrel(k => k.ConfigureEndpointDefaults(listen =>
{
    if (listen.IPEndPoint?.Port == grpcPort) listen.Protocols = Microsoft.AspNetCore.Server.Kestrel.Core.HttpProtocols.Http2;
}));
builder.Services.AddScoped<GroupMemberFilter>();
builder.Services.AddScoped<TableSessionService>();
builder.Services.AddScoped<GuestFilter>();
builder.Services.AddSingleton<ListenTokens>();
// Browsers on another origin (local dev: web on :3000, ledger on :5080) open the hub cross-origin.
var webOrigins = builder.Configuration["Ledger:WebOrigins"]?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries) ?? [];
builder.Services.AddCors(o => o.AddPolicy("hub", p => p.WithOrigins(webOrigins).AllowAnyHeader().WithMethods("GET", "POST")));
builder.Services.AddSingleton<ITableNotifier, SignalRTableNotifier>();
var signalR = builder.Services.AddSignalR();
if (builder.Configuration.GetConnectionString("redis") is { Length: > 0 } redis)
    signalR.AddStackExchangeRedis(redis, o => o.Configuration.ChannelPrefix = StackExchange.Redis.RedisChannel.Literal("kitty"));

var app = builder.Build();
if (KafkaOptions.From(app.Configuration) is null)
    app.Logger.LogWarning("Kafka is not configured (ConnectionStrings:kafka); events stay in the outbox until it is.");

if (app.Configuration.GetValue<bool>("Ledger:MigrateOnStartup"))
{
    using var scope = app.Services.CreateScope();
    await scope.ServiceProvider.GetRequiredService<LedgerDbContext>().Database.MigrateAsync();
}

if (app.Configuration.GetValue<bool>("Ledger:TrustForwardedHeaders")) app.UseForwardedHeaders();
app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseCors();
app.UseAuthentication();
app.UseMiddleware<ServiceTokenGuard>();
app.UseAuthorization();
app.UseRateLimiter();
app.UseMiddleware<IdempotencyMiddleware>();

app.MapDefaultEndpoints();
app.MapOpenApi().AllowAnonymous();
app.MapMe();
app.MapNotificationSettings();
var group = app.MapGroups();
group.MapMembers();
group.MapExpenses();
group.MapBalances();
group.MapSettlements();
group.MapFx();
group.MapRecurring();
group.MapActivity();
group.MapTableSessions();
var guestTable = app.MapGuestTable();
ListenTokens.Map(group, guestTable);
app.MapGrpcService<RecurringGrpcService>().RequireHost($"*:{grpcPort}").RequireAuthorization("pulse");
app.MapHub<TableHub>(TableHub.Path).AllowAnonymous().RequireCors("hub"); // JoinSession does the authorization
app.MapInvites(group);

app.Run();

public partial class Program;
