using Kitty.Ledger.Data;
using System.Text.Json;
using System.Text.Json.Serialization;
using Kitty.Ledger.Features;
using Kitty.Ledger.Features.Expenses;
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
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase)));
builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddDbContext<LedgerDbContext>((sp, options) =>
    options.UseNpgsql(sp.GetRequiredService<IConfiguration>().GetConnectionString("ledger")
        ?? throw new InvalidOperationException("Connection string 'ledger' is not configured.")));
builder.Services.AddLedgerAuth(builder.Configuration, builder.Environment);
builder.Services.AddWriteRateLimiting(builder.Configuration);
builder.Services.AddHostedService<IdempotencyCleanup>();
builder.Services.AddScoped<AuditWriter>();
builder.Services.AddScoped<GroupMemberFilter>();

var app = builder.Build();

if (app.Configuration.GetValue<bool>("Ledger:MigrateOnStartup"))
{
    using var scope = app.Services.CreateScope();
    await scope.ServiceProvider.GetRequiredService<LedgerDbContext>().Database.MigrateAsync();
}

app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();
app.UseMiddleware<IdempotencyMiddleware>();

app.MapDefaultEndpoints();
app.MapMe();
var group = app.MapGroups();
group.MapMembers();
group.MapExpenses();
app.MapInvites(group);

app.Run();

public partial class Program;
