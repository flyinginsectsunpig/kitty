using System.Net.Http.Json;

namespace Kitty.Ledger.IntegrationTests;

public sealed record MemberDto(Guid Id, string DisplayName, Guid? UserId, bool IsPlaceholder, string? PaymentDetails);
public sealed record GroupDto(Guid Id, string Name, string BaseCurrency, List<MemberDto> Members);
public sealed record NetDto(string Currency, long NetMinor);
public sealed record GroupSummaryDto(Guid Id, string Name, string BaseCurrency, int MemberCount, List<NetDto> MyNet);
public sealed record InviteDto(string Token, DateTimeOffset ExpiresAt);
public sealed record InvitePreviewDto(string GroupName, string? PlaceholderName, DateTimeOffset ExpiresAt);
public sealed record MeDto(Guid Id, string DisplayName, string? Email);

/// <summary>Arrange helpers shared by the API tests.</summary>
public static class TestData
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public static HttpClient NewUser(this LedgerApiFactory f, string name = "Test User") =>
        f.CreateClientFor($"sub-{Guid.NewGuid()}", name);

    public static async Task<MeDto> MeAsync(this HttpClient c) => (await c.GetFromJsonAsync<MeDto>("/me", Ct))!;

    public static async Task<GroupDto> CreateGroupAsync(this HttpClient c, string name = "Flat 4B", string currency = "ZAR")
    {
        var r = await c.PostJsonAsync("/groups", new { id = Guid.NewGuid(), name, baseCurrency = currency });
        r.EnsureSuccessStatusCode();
        return await r.ReadAsync<GroupDto>();
    }

    public static async Task<MemberDto> AddPlaceholderAsync(this HttpClient c, Guid groupId, string name)
    {
        var r = await c.PostJsonAsync($"/groups/{groupId}/members", new { displayName = name });
        r.EnsureSuccessStatusCode();
        return await r.ReadAsync<MemberDto>();
    }

    public static async Task<InviteDto> CreateInviteAsync(this HttpClient c, Guid groupId, Guid? memberId = null)
    {
        var r = await c.PostJsonAsync($"/groups/{groupId}/invites", new { memberId });
        r.EnsureSuccessStatusCode();
        return await r.ReadAsync<InviteDto>();
    }

    /// <summary>Owner creates a group and an open invite; the second user accepts it.</summary>
    public static async Task<GroupDto> JoinAsync(this HttpClient joiner, HttpClient owner, Guid groupId)
    {
        var invite = await owner.CreateInviteAsync(groupId);
        var r = await joiner.PostJsonAsync($"/invites/{invite.Token}/accept", new { });
        r.EnsureSuccessStatusCode();
        return await r.ReadAsync<GroupDto>();
    }
}
