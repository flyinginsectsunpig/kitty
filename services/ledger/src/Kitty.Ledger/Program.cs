using Kitty.Ledger.Data;
using Kitty.Ledger.Features.Me;
using Kitty.Ledger.Infrastructure.Auth;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();
builder.Services.AddProblemDetails();
builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddDbContext<LedgerDbContext>((sp, options) =>
    options.UseNpgsql(sp.GetRequiredService<IConfiguration>().GetConnectionString("ledger")
        ?? throw new InvalidOperationException("Connection string 'ledger' is not configured.")));
builder.Services.AddLedgerAuth(builder.Configuration, builder.Environment);

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

app.MapDefaultEndpoints();
app.MapMe();

app.Run();

public partial class Program;
