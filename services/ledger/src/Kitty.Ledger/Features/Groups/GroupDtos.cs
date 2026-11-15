using Kitty.Ledger.Data.Entities;

namespace Kitty.Ledger.Features.Groups;

public sealed record CreateGroupDto(Guid Id, string Name, string BaseCurrency);
public sealed record UpdateGroupDto(string Name);
public sealed record MemberDto(Guid Id, string DisplayName, Guid? UserId, bool IsPlaceholder, string? PaymentDetails);
public sealed record GroupDto(Guid Id, string Name, string BaseCurrency, IReadOnlyList<MemberDto> Members);
public sealed record NetDto(string Currency, long NetMinor);
public sealed record GroupSummaryDto(Guid Id, string Name, string BaseCurrency, int MemberCount, IReadOnlyList<NetDto> MyNet);

public static class GroupMapping
{
    public static MemberDto ToDto(this Member m) => new(m.Id, m.DisplayName, m.UserId, m.UserId is null, m.PaymentDetails);

    public static GroupDto ToDto(this Group g, IEnumerable<Member> members) =>
        new(g.Id, g.Name, g.BaseCurrency.Trim(), members.OrderBy(m => m.JoinedAt).ThenBy(m => m.Id).Select(ToDto).ToList());
}
