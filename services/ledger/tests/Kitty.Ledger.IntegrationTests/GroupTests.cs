using System.Net;
using System.Net.Http.Json;
using Kitty.Ledger.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Kitty.Ledger.IntegrationTests;

[Collection(ApiCollection.Name)]
public class GroupTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Create_group_makes_creator_a_member()
    {
        var c = factory.NewUser("Thandi");
        var me = await c.MeAsync();
        var g = await c.CreateGroupAsync("Flat 4B");

        var member = Assert.Single(g.Members);
        Assert.Equal(me.Id, member.UserId);
        Assert.Equal("Thandi", member.DisplayName);
        Assert.False(member.IsPlaceholder);
        Assert.Equal("ZAR", g.BaseCurrency);
    }

    [Fact]
    public async Task Create_group_with_existing_id_returns_409()
    {
        var c = factory.NewUser();
        var id = Guid.NewGuid();
        (await c.PostJsonAsync("/groups", new { id, name = "One", baseCurrency = "ZAR" })).EnsureSuccessStatusCode();
        var r = await c.PostJsonAsync("/groups", new { id, name = "Two", baseCurrency = "ZAR" });
        Assert.Equal(HttpStatusCode.Conflict, r.StatusCode);
        Assert.Equal("already_exists", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Unsupported_base_currency_returns_400()
    {
        var r = await factory.NewUser().PostJsonAsync("/groups", new { id = Guid.NewGuid(), name = "X", baseCurrency = "XXX" });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal("currency_unsupported", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Non_member_gets_404()
    {
        var owner = factory.NewUser();
        var g = await owner.CreateGroupAsync();
        var stranger = factory.NewUser("Eve");

        var get = await stranger.GetAsync($"/groups/{g.Id}", Ct);
        Assert.Equal(HttpStatusCode.NotFound, get.StatusCode);
        Assert.Equal("not_found", await get.ReadCodeAsync());

        var add = await stranger.PostJsonAsync($"/groups/{g.Id}/members", new { displayName = "Sneaky" });
        Assert.Equal(HttpStatusCode.NotFound, add.StatusCode);
    }

    [Fact]
    public async Task Group_list_only_shows_my_groups()
    {
        var a = factory.NewUser();
        var b = factory.NewUser();
        var mine = await a.CreateGroupAsync("Mine");
        await b.CreateGroupAsync("Theirs");

        var list = (await a.GetFromJsonAsync<List<GroupSummaryDto>>("/groups", Ct))!;
        Assert.Equal([mine.Id], list.Select(g => g.Id));
        Assert.Equal(1, list[0].MemberCount);
        Assert.InRange(list[0].CreatedAt, DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddMinutes(1));
    }

    [Fact]
    public async Task Rename_group()
    {
        var c = factory.NewUser();
        var g = await c.CreateGroupAsync("Old");
        var r = await c.PatchJsonAsync($"/groups/{g.Id}", new { name = "  New name  " });
        Assert.Equal("New name", (await r.ReadAsync<GroupDto>()).Name);
    }

    [Fact]
    public async Task Edit_placeholder_and_own_payment_details_but_not_other_users()
    {
        var owner = factory.NewUser("Owner");
        var g = await owner.CreateGroupAsync();
        var gran = await owner.AddPlaceholderAsync(g.Id, "Gran");
        var friend = factory.NewUser("Friend");
        var joined = await friend.JoinAsync(owner, g.Id);
        var friendMember = joined.Members.Single(m => m.DisplayName == "Friend");
        var ownerMember = joined.Members.Single(m => m.DisplayName == "Owner");

        var editGran = await owner.PatchJsonAsync($"/groups/{g.Id}/members/{gran.Id}", new { displayName = "Granny" });
        Assert.Equal("Granny", (await editGran.ReadAsync<MemberDto>()).DisplayName);

        var editOwn = await friend.PatchJsonAsync($"/groups/{g.Id}/members/{friendMember.Id}", new { paymentDetails = "PayShap 082 000 0000" });
        Assert.Equal("PayShap 082 000 0000", (await editOwn.ReadAsync<MemberDto>()).PaymentDetails);

        var editOther = await friend.PatchJsonAsync($"/groups/{g.Id}/members/{ownerMember.Id}", new { displayName = "Hacked" });
        Assert.Equal(HttpStatusCode.NotFound, editOther.StatusCode);
    }

    [Fact]
    public async Task Nobody_can_set_payment_details_for_a_placeholder()
    {
        // Otherwise a member could put their own bank details on "Gran" and redirect settle-ups.
        var owner = factory.NewUser("Owner");
        var g = await owner.CreateGroupAsync();
        var gran = await owner.AddPlaceholderAsync(g.Id, "Gran");

        var r = await owner.PatchJsonAsync($"/groups/{g.Id}/members/{gran.Id}", new { paymentDetails = "Owner's account 123" });
        Assert.Equal(HttpStatusCode.BadRequest, r.StatusCode);
        Assert.Equal("validation_failed", await r.ReadCodeAsync());
    }

    [Fact]
    public async Task Every_mutation_writes_an_audit_entry()
    {
        var c = factory.NewUser();
        var g = await c.CreateGroupAsync();
        await c.AddPlaceholderAsync(g.Id, "Gran");
        (await c.PatchJsonAsync($"/groups/{g.Id}", new { name = "Renamed" })).EnsureSuccessStatusCode();

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<LedgerDbContext>();
        var actions = await db.AuditEntries.Where(a => a.GroupId == g.Id).OrderBy(a => a.At)
            .Select(a => a.EntityType + ":" + a.Action).ToListAsync(Ct);
        Assert.Equal(["group:created", "member:created", "member:created", "group:updated"], actions);
    }
}
