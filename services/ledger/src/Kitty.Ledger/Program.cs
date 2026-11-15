using Kitty.Ledger.Data;
using System.Text.Json;
using System.Text.Json.Serialization;
using Kitty.Ledger.Features;
using Kitty.Ledger.Features.Activity;
using Kitty.Ledger.Features.Balances;
using Kitty.Ledger.Features.Expenses;
using Kitty.Ledger.Features.Settlements;
using Kitty.Ledger.Features.Table;
using Kitty.Ledger.Features.Groups;
using Kitty.Ledger.Features.Invites;
using Kitty.Ledger.Features.Me;
using Kitty.Ledger.Infrastructure.Audit;
using Kitty.Ledger.Infrastructure.Auth;
using Kitty.Ledger.Infrastructure.Idempotency;
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
builder.Services.AddScoped<GroupMemberFilter>();
builder.Services.AddScoped<TableSessionService>();
builder.Services.AddScoped<GuestFilter>();
builder.Services.AddSingleton<ITableNotifier, SignalRTableNotifier>();
var signalR = builder.Services.AddSignalR();
if (builder.Configuration.GetConnectionString("redis") is { Length: > 0 } redis)
    signalR.AddStackExchangeRedis(redis, o => o.Configuration.ChannelPrefix = StackExchange.Redis.RedisChannel.Literal("kitty"));

var app = builder.Build();

if (app.Configuration.GetValue<bool>("Ledger:MigrateOnStartup"))
{
    using var scope = app.Services.CreateScope();
    await scope.ServiceProvider.GetRequiredService<LedgerDbContext>().Database.MigrateAsync();
}

if (app.Configuration.GetValue<bool>("Ledger:TrustForwardedHeaders")) app.UseForwardedHeaders();
app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();
app.UseMiddleware<IdempotencyMiddleware>();

app.MapDefaultEndpoints();
app.MapOpenApi().AllowAnonymous();
app.MapMe();
var group = app.MapGroups();
group.MapMembers();
group.MapExpenses();
group.MapBalances();
group.MapSettlements();
group.MapActivity();
group.MapTableSessions();
app.MapGuestTable();
app.MapHub<TableHub>(TableHub.Path).AllowAnonymous(); // JoinSession does the authorization
app.MapInvites(group);

app.Run();

public partial class Program;
