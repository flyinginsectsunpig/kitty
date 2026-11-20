using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Kitty.Ledger.IntegrationTests;

[Collection(ApiCollection.Name)]
public class TableSchemaTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private async Task<(LedgerDbContext Db, IServiceScope Scope, ReceiptItem Item, Guid MemberA, Guid MemberB)> SessionWithItemAsync()
    {
        var c = factory.NewUser("Host");
        var g = await c.CreateGroupAsync();
        var other = await c.AddPlaceholderAsync(g.Id, "Sam");
        var me = await c.MeAsync();

        var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<LedgerDbContext>();
        var now = DateTimeOffset.UtcNow;
        var session = new ReceiptSession
        {
            Id = Guid.NewGuid(), GroupId = g.Id, HostUserId = me.Id, PayerMemberId = g.Members[0].Id, Currency = "ZAR",
            Title = "Dinner", Status = SessionStatus.Open, Version = 1, CreatedAt = now, UpdatedAt = now,
        };
        var item = new ReceiptItem { Id = Guid.NewGuid(), SessionId = session.Id, Description = "Burger", Quantity = 1, LineTotalMinor = 12000, Position = 0 };
        session.Items.Add(item);
        session.Charges.Add(new ReceiptCharge { Id = Guid.NewGuid(), SessionId = session.Id, Kind = ChargeKinds.Tip, AmountMinor = 1200 });
        session.Guests.Add(new Guest
        {
            Id = Guid.NewGuid(), SessionId = session.Id, DisplayName = "Zoe", TokenHash = Convert.ToHexStringLower(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)), ExpiresAt = now.AddDays(1),
        });
        db.ReceiptSessions.Add(session);
        await db.SaveChangesAsync(Ct);
        return (db, scope, item, g.Members[0].Id, other.Id);
    }

    [Fact]
    public async Task Different_people_can_claim_the_same_item()
    {
        var (db, scope, item, a, b) = await SessionWithItemAsync();
        using (scope)
        {
            db.ItemClaims.AddRange(
                new ItemClaim { ItemId = item.Id, ClaimantKind = ClaimantKinds.Member, ClaimantId = a },
                new ItemClaim { ItemId = item.Id, ClaimantKind = ClaimantKinds.Member, ClaimantId = b });
            Assert.Equal(2, await db.SaveChangesAsync(Ct));
        }
    }

    [Fact]
    public async Task Duplicate_claim_by_same_person_is_rejected_by_key()
    {
        var (db, scope, item, a, _) = await SessionWithItemAsync();
        using (scope)
        {
            db.ItemClaims.Add(new ItemClaim { ItemId = item.Id, ClaimantKind = ClaimantKinds.Member, ClaimantId = a });
            await db.SaveChangesAsync(Ct);
            db.ChangeTracker.Clear();

            db.ItemClaims.Add(new ItemClaim { ItemId = item.Id, ClaimantKind = ClaimantKinds.Member, ClaimantId = a });
            await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync(Ct));
        }
    }
}
