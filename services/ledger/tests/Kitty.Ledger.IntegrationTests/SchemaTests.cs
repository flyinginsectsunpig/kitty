using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Kitty.Ledger.IntegrationTests;

[Collection(ApiCollection.Name)]
public class SchemaTests(LedgerApiFactory factory)
{
    [Fact]
    public async Task Migrations_apply_and_member_user_is_unique_per_group()
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<LedgerDbContext>();
        var now = DateTimeOffset.UtcNow;

        var user = new User { Id = Guid.NewGuid(), KeycloakSub = $"sub-{Guid.NewGuid()}", DisplayName = "Thandi", Email = "t@example.com" };
        var group = new Group { Id = Guid.NewGuid(), Name = "Flat 4B", BaseCurrency = "ZAR", CreatedByUserId = user.Id, CreatedAt = now };
        db.AddRange(user, group,
            new Member { Id = Guid.NewGuid(), GroupId = group.Id, DisplayName = "Thandi", UserId = user.Id, JoinedAt = now });
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);

        db.Add(new Member { Id = Guid.NewGuid(), GroupId = group.Id, DisplayName = "Thandi again", UserId = user.Id, JoinedAt = now });
        await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Many_placeholders_without_users_are_allowed()
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<LedgerDbContext>();
        var now = DateTimeOffset.UtcNow;

        var user = new User { Id = Guid.NewGuid(), KeycloakSub = $"sub-{Guid.NewGuid()}", DisplayName = "Sam", Email = null };
        var group = new Group { Id = Guid.NewGuid(), Name = "Trip", BaseCurrency = "ZAR", CreatedByUserId = user.Id, CreatedAt = now };
        db.AddRange(user, group,
            new Member { Id = Guid.NewGuid(), GroupId = group.Id, DisplayName = "Gran", JoinedAt = now },
            new Member { Id = Guid.NewGuid(), GroupId = group.Id, DisplayName = "Uncle", JoinedAt = now });

        Assert.Equal(4, await db.SaveChangesAsync(TestContext.Current.CancellationToken));
    }
}
