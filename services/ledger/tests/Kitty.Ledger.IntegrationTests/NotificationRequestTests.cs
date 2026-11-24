using System.Net.Http.Headers;
using Kitty.Contracts.Notify.V1;
using Kitty.Ledger.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Kitty.Ledger.IntegrationTests;

[Collection(ApiCollection.Name)]
public class NotificationRequestTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed record Group(HttpClient Owner, HttpClient Friend, HttpClient Bystander, GroupDto G, Guid OwnerM, Guid FriendM,
        Guid BystanderM, Guid GranM, Guid OwnerU, Guid FriendU, Guid BystanderU);

    /// <summary>Owner, a joined friend, a joined bystander (not on the expense) and a placeholder (no account).</summary>
    private async Task<Group> GroupAsync()
    {
        var owner = factory.NewUser("Owner");
        var g = await owner.CreateGroupAsync("Flat 4B");
        var friend = factory.NewUser("Friend");
        var bystander = factory.NewUser("Bystander");
        await friend.JoinAsync(owner, g.Id);
        var joined = await bystander.JoinAsync(owner, g.Id);
        var gran = await owner.AddPlaceholderAsync(g.Id, "Gran");
        Guid M(string name) => joined.Members.Single(m => m.DisplayName == name).Id;
        return new Group(owner, friend, bystander, joined, M("Owner"), M("Friend"), M("Bystander"), gran.Id,
            (await owner.MeAsync()).Id, (await friend.MeAsync()).Id, (await bystander.MeAsync()).Id);
    }

    private async Task<List<NotificationRequested>> RequestsForAsync(Guid groupId)
    {
        using var scope = factory.Services.CreateScope();
        var rows = await scope.ServiceProvider.GetRequiredService<LedgerDbContext>().OutboxMessages
            .Where(m => m.Topic == "notifications.requested").Select(m => m.Payload).ToListAsync(Ct);
        return rows.Select(NotificationRequested.Parser.ParseFrom).Where(r => r.GroupId == groupId.ToString()).ToList();
    }

    [Fact]
    public async Task Only_involved_members_with_accounts_except_the_actor_are_told()
    {
        var x = await GroupAsync();
        var other = await GroupAsync(); // another group's expense must not leak into this one's requests
        await other.Owner.AddEqualAsync(other.G.Id, 9000, other.OwnerM, [other.OwnerM, other.FriendM]);

        await x.Owner.AddEqualAsync(x.G.Id, 45000, x.OwnerM, [x.OwnerM, x.FriendM, x.GranM]);

        var r = Assert.Single(await RequestsForAsync(x.G.Id));
        Assert.Equal(x.FriendU.ToString(), r.UserId);
        Assert.Equal(NotificationRequested.Types.Kind.ExpenseAdded, r.Kind);
    }

    [Fact]
    public async Task Expense_text_names_actor_description_and_share()
    {
        var x = await GroupAsync();
        await x.Owner.AddEqualAsync(x.G.Id, 30000, x.OwnerM, [x.OwnerM, x.FriendM]); // "Dinner", R 300,00 split in two

        var r = Assert.Single(await RequestsForAsync(x.G.Id));

        Assert.Equal("Flat 4B", r.Title);
        Assert.Equal("Owner added Dinner · your share R 150,00", r.Body);
        Assert.Equal($"kitty://groups/{x.G.Id}", r.Link);
        Assert.True(Guid.TryParse(r.NotificationId, out _));
    }

    [Fact]
    public async Task A_payer_without_a_share_is_told_what_they_paid()
    {
        var x = await GroupAsync();
        // The friend paid for the owner's dinner (owner adds it, friend paid, only the owner shares).
        await x.Owner.AddEqualAsync(x.G.Id, 20000, x.FriendM, [x.OwnerM]);

        var r = Assert.Single(await RequestsForAsync(x.G.Id));
        Assert.Equal(x.FriendU.ToString(), r.UserId);
        Assert.Equal("Owner added Dinner · you paid R 200,00", r.Body);
    }

    [Fact]
    public async Task A_payment_tells_the_other_party()
    {
        var x = await GroupAsync();
        (await x.Friend.PostJsonAsync($"/groups/{x.G.Id}/settlements", new
        {
            id = Guid.NewGuid(), fromMemberId = x.FriendM, toMemberId = x.OwnerM, currency = "ZAR", amountMinor = 50000,
        })).EnsureSuccessStatusCode();

        var r = Assert.Single(await RequestsForAsync(x.G.Id));
        Assert.Equal((x.OwnerU.ToString(), NotificationRequested.Types.Kind.Payment), (r.UserId, r.Kind));
        Assert.Equal("Friend marked R 500,00 paid to you", r.Body);
    }

    [Fact]
    public async Task A_payment_recorded_by_a_third_person_tells_both_sides()
    {
        var x = await GroupAsync();
        (await x.Bystander.PostJsonAsync($"/groups/{x.G.Id}/settlements", new
        {
            id = Guid.NewGuid(), fromMemberId = x.FriendM, toMemberId = x.OwnerM, currency = "ZAR", amountMinor = 50000,
        })).EnsureSuccessStatusCode();

        var bodies = (await RequestsForAsync(x.G.Id)).ToDictionary(r => r.UserId, r => r.Body);
        Assert.Equal("Bystander marked R 500,00 paid to you", bodies[x.OwnerU.ToString()]);
        Assert.Equal("Bystander marked R 500,00 paid by you", bodies[x.FriendU.ToString()]);
    }

    [Fact]
    public async Task Table_confirm_tells_the_claimers()
    {
        var x = await GroupAsync();
        var s = await x.Owner.CreateSessionAsync(x.G.Id, x.OwnerM);
        var burger = Guid.NewGuid();
        (await x.Owner.PutItemsAsync(x.G.Id, s.Id, (burger, "Burger", 12000))).EnsureSuccessStatusCode();
        (await x.Friend.ClaimAsync(x.G.Id, s.Id, burger)).EnsureSuccessStatusCode();
        (await x.Owner.PostJsonAsync($"/groups/{x.G.Id}/table-sessions/{s.Id}/confirm", new { })).EnsureSuccessStatusCode();

        var r = Assert.Single(await RequestsForAsync(x.G.Id));
        Assert.Equal(x.FriendU.ToString(), r.UserId);
        Assert.Equal("Owner added Dinner · your share R 120,00", r.Body);
    }

    [Fact]
    public async Task Requests_reach_kafka_keyed_by_user()
    {
        var x = await GroupAsync();
        await x.Owner.AddEqualAsync(x.G.Id, 30000, x.OwnerM, [x.OwnerM, x.FriendM]);

        var events = await KafkaProbe.WaitForAsync<NotificationRequested>(factory, "notifications.requested",
            e => e.GroupId == x.G.Id.ToString());

        var (key, e) = Assert.Single(events);
        Assert.Equal((x.FriendU.ToString(), x.FriendU.ToString()), (key, e.UserId));
    }
}
