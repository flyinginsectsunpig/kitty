using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Kitty.Ledger.Data;

/// <summary>Lets `dotnet ef` build the model without booting the app (no real database needed).</summary>
public sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<LedgerDbContext>
{
    public LedgerDbContext CreateDbContext(string[] args) =>
        new(new DbContextOptionsBuilder<LedgerDbContext>().UseNpgsql("Host=localhost;Database=ledger").Options);
}
