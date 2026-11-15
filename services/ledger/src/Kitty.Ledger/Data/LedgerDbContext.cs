using Kitty.Ledger.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Data;

public sealed class LedgerDbContext(DbContextOptions<LedgerDbContext> options) : DbContext(options)
{
    public DbSet<User> Users => Set<User>();
    public DbSet<Group> Groups => Set<Group>();
    public DbSet<Member> Members => Set<Member>();
    public DbSet<Invite> Invites => Set<Invite>();
    public DbSet<Expense> Expenses => Set<Expense>();
    public DbSet<Settlement> Settlements => Set<Settlement>();
    public DbSet<AuditEntry> AuditEntries => Set<AuditEntry>();
    public DbSet<IdempotencyRecord> IdempotencyRecords => Set<IdempotencyRecord>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<User>(e =>
        {
            e.HasIndex(u => u.KeycloakSub).IsUnique();
            e.Property(u => u.KeycloakSub).HasMaxLength(255);
            e.Property(u => u.DisplayName).HasMaxLength(100);
            e.Property(u => u.Email).HasMaxLength(320);
        });

        b.Entity<Group>(e =>
        {
            e.Property(g => g.Name).HasMaxLength(60);
            e.Property(g => g.BaseCurrency).HasMaxLength(3).IsFixedLength();
            e.HasMany(g => g.Members).WithOne().HasForeignKey(m => m.GroupId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne<User>().WithMany().HasForeignKey(g => g.CreatedByUserId).OnDelete(DeleteBehavior.Restrict);
        });

        b.Entity<Member>(e =>
        {
            e.Property(m => m.DisplayName).HasMaxLength(40);
            e.Property(m => m.PaymentDetails).HasMaxLength(500);
            // Postgres treats NULLs as distinct, so many placeholders per group are allowed.
            e.HasIndex(m => new { m.GroupId, m.UserId }).IsUnique();
            e.HasOne<User>().WithMany().HasForeignKey(m => m.UserId).OnDelete(DeleteBehavior.Restrict);
            e.Property(m => m.UserId).IsConcurrencyToken(); // a placeholder is claimed at most once
        });

        b.Entity<Invite>(e =>
        {
            e.HasIndex(i => i.Token).IsUnique();
            e.Property(i => i.Token).HasMaxLength(43);
            e.Property(i => i.UsedAt).IsConcurrencyToken(); // an invite is used at most once
            e.HasOne<Group>().WithMany().HasForeignKey(i => i.GroupId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne<Member>().WithMany().HasForeignKey(i => i.MemberId).OnDelete(DeleteBehavior.Restrict);
        });

        b.Entity<Expense>(e =>
        {
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.Description).HasMaxLength(120);
            e.Property(x => x.Category).HasMaxLength(20);
            e.Property(x => x.Currency).HasMaxLength(3).IsFixedLength();
            e.Property(x => x.SplitMethod).HasConversion<string>().HasMaxLength(10);
            e.Property(x => x.Version).IsConcurrencyToken();
            e.HasIndex(x => new { x.GroupId, x.OccurredOn, x.CreatedAt, x.Id });
            e.HasOne<Group>().WithMany().HasForeignKey(x => x.GroupId).OnDelete(DeleteBehavior.Restrict);
            e.OwnsMany(x => x.Payers, p =>
            {
                p.ToTable("ExpensePayers");
                p.WithOwner().HasForeignKey("ExpenseId");
                p.HasKey("ExpenseId", nameof(ExpensePayer.MemberId));
                p.HasOne<Member>().WithMany().HasForeignKey(x => x.MemberId).OnDelete(DeleteBehavior.Restrict);
            });
            e.OwnsMany(x => x.Shares, s =>
            {
                s.ToTable("ExpenseShares");
                s.WithOwner().HasForeignKey("ExpenseId");
                s.HasKey("ExpenseId", nameof(ExpenseShare.MemberId));
                s.HasOne<Member>().WithMany().HasForeignKey(x => x.MemberId).OnDelete(DeleteBehavior.Restrict);
            });
        });

        b.Entity<Settlement>(e =>
        {
            e.Property(x => x.Id).ValueGeneratedNever();
            e.Property(x => x.Currency).HasMaxLength(3).IsFixedLength();
            e.HasOne<Group>().WithMany().HasForeignKey(x => x.GroupId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne<Member>().WithMany().HasForeignKey(x => x.FromMemberId).OnDelete(DeleteBehavior.Restrict);
            e.HasOne<Member>().WithMany().HasForeignKey(x => x.ToMemberId).OnDelete(DeleteBehavior.Restrict);
        });

        b.Entity<AuditEntry>(e =>
        {
            e.Property(a => a.EntityType).HasMaxLength(30);
            e.Property(a => a.Action).HasMaxLength(10);
            e.Property(a => a.Before).HasColumnType("jsonb");
            e.Property(a => a.After).HasColumnType("jsonb");
            e.HasIndex(a => new { a.GroupId, a.At });
        });

        b.Entity<IdempotencyRecord>(e =>
        {
            e.HasKey(r => new { r.UserId, r.Key });
            e.Property(r => r.Key).HasMaxLength(255);
            e.Property(r => r.RequestHash).HasMaxLength(64);
            e.Property(r => r.Status).HasMaxLength(12);
            e.HasIndex(r => r.CreatedAt);
        });
    }
}
