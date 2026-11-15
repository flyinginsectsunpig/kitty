using System.Net.Http.Json;
using System.Threading.Channels;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;

namespace Kitty.Ledger.IntegrationTests;

public sealed record SessionChanged(Guid SessionId, int Version);

[Collection(ApiCollection.Name)]
public class TableHubTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private async Task<(HubConnection Connection, Channel<SessionChanged> Events)> ConnectAsync(string query, string? bearer = null)
    {
        var events = Channel.CreateUnbounded<SessionChanged>();
        var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(factory.Server.BaseAddress, "/hubs/table?" + query), o =>
            {
                o.Transports = HttpTransportType.LongPolling; // the in-memory test server has no real sockets
                o.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                if (bearer is not null) o.AccessTokenProvider = () => Task.FromResult<string?>(bearer);
            })
            .Build();
        connection.On<SessionChanged>("SessionChanged", e => events.Writer.TryWrite(e));
        await connection.StartAsync(Ct);
        return (connection, events);
    }

    private static async Task<SessionChanged> NextAsync(Channel<SessionChanged> events)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(Ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        return await events.Reader.ReadAsync(timeout.Token);
    }

    private async Task<(HttpClient Host, GroupDto Group, TableSessionDto Session, string FriendSub, Guid Burger)> TableAsync()
    {
        var host = factory.NewUser("Host");
        var g = await host.CreateGroupAsync();
        var friendSub = $"sub-{Guid.NewGuid()}";
        await factory.CreateClientFor(friendSub, "Friend").JoinAsync(host, g.Id);
        var s = await host.CreateSessionAsync(g.Id, g.Members[0].Id);
        var burger = Guid.NewGuid(); // item ids are primary keys: fresh per session
        (await host.PutItemsAsync(g.Id, s.Id, (burger, "Burger", 12000))).EnsureSuccessStatusCode();
        return (host, g, s, friendSub, burger);
    }

    [Fact]
    public async Task Member_receives_change_after_claim()
    {
        var (host, g, s, friendSub, burger) = await TableAsync();
        var (connection, events) = await ConnectAsync("", TestTokens.For(friendSub, "Friend", "f@example.com"));
        await using var _ = connection;
        await connection.InvokeAsync("JoinSession", s.Id, Ct);

        (await host.ClaimAsync(g.Id, s.Id, burger)).EnsureSuccessStatusCode();

        var changed = await NextAsync(events);
        Assert.Equal(s.Id, changed.SessionId);
        Assert.Equal((await host.GetSessionAsync(g.Id, s.Id)).Version, changed.Version);
    }

    [Fact]
    public async Task Guest_receives_change()
    {
        var (host, g, s, _, burger) = await TableAsync();
        var join = await (await factory.CreateClient().PostAsJsonAsync($"/table-sessions/{s.Id}/join", new { displayName = "Zoe" }, Ct))
            .ReadAsync<GuestJoinDto>();
        var (connection, events) = await ConnectAsync("guest_token=" + Uri.EscapeDataString(join.GuestToken));
        await using var _ = connection;
        await connection.InvokeAsync("JoinSession", s.Id, Ct);

        (await host.PutItemsAsync(g.Id, s.Id, (burger, "Burger", 12000), (Guid.NewGuid(), "Chips", 3000))).EnsureSuccessStatusCode();

        Assert.Equal(s.Id, (await NextAsync(events)).SessionId);
    }

    [Fact]
    public async Task Stranger_cannot_join_session_group()
    {
        var (_, _, s, _, _) = await TableAsync();
        var stranger = $"sub-{Guid.NewGuid()}";
        await factory.CreateClientFor(stranger, "Eve").MeAsync();
        var (connection, _) = await ConnectAsync("", TestTokens.For(stranger, "Eve", "e@example.com"));
        await using var _ = connection;

        await Assert.ThrowsAsync<HubException>(() => connection.InvokeAsync("JoinSession", s.Id, Ct));
    }

    [Fact]
    public async Task Guest_token_for_another_session_cannot_join()
    {
        var (_, _, s, _, _) = await TableAsync();
        var (_, _, other, _, _) = await TableAsync();
        var join = await (await factory.CreateClient().PostAsJsonAsync($"/table-sessions/{other.Id}/join", new { displayName = "Zoe" }, Ct))
            .ReadAsync<GuestJoinDto>();
        var (connection, _) = await ConnectAsync("guest_token=" + Uri.EscapeDataString(join.GuestToken));
        await using var _ = connection;

        await Assert.ThrowsAsync<HubException>(() => connection.InvokeAsync("JoinSession", s.Id, Ct));
    }
}
