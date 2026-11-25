using Kitty.Ledger.Domain.Splits;

namespace Kitty.Ledger.Data.Entities;

/// <summary>A Keycloak account, mirrored on first authenticated request.</summary>
public sealed class User
{
    public Guid Id { get; set; }
    public required string KeycloakSub { get; set; }
    public required string DisplayName { get; set; }
    public string? Email { get; set; }
    /// <summary>Keycloak verified <see cref="Email"/>; only a verified address gets notification email.</summary>
    public bool EmailVerified { get; set; }
}

public sealed class Group
{
    public Guid Id { get; set; }
    public required string Name { get; set; }
    public required string BaseCurrency { get; set; }
    public Guid CreatedByUserId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public List<Member> Members { get; set; } = [];
}

/// <summary>Someone in a group. UserId is null for a placeholder ("Gran") until they accept an invite.</summary>
public sealed class Member
{
    public Guid Id { get; set; }
    public Guid GroupId { get; set; }
    public required string DisplayName { get; set; }
    public Guid? UserId { get; set; }
    public string? PaymentDetails { get; set; }
    public DateTimeOffset JoinedAt { get; set; }
}

public sealed class Invite
{
    public Guid Id { get; set; }
    public Guid GroupId { get; set; }
    public required string Token { get; set; }
    public Guid? MemberId { get; set; }
    public Guid CreatedByUserId { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset? UsedAt { get; set; }
    public Guid? UsedByUserId { get; set; }
}

public static class Categories
{
    public static readonly IReadOnlySet<string> All = new HashSet<string>(StringComparer.Ordinal)
    {
        "food", "groceries", "transport", "accommodation", "utilities", "rent", "entertainment", "shopping", "other",
    };
}

public sealed class Expense
{
    public Guid Id { get; set; }
    public Guid GroupId { get; set; }
    public required string Description { get; set; }
    public required string Category { get; set; }
    public required string Currency { get; set; }
    public long AmountMinor { get; set; }
    public DateOnly OccurredOn { get; set; }
    public SplitMethod SplitMethod { get; set; }
    public int Version { get; set; }
    public Guid CreatedByUserId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
    /// <summary>1 unit of <see cref="Currency"/> in the group's currency; null for the group's own currency, or when no rate was available.</summary>
    public decimal? FxRate { get; set; }
    /// <summary>The ECB publication the rate came from; null when typed by hand.</summary>
    public DateOnly? FxRateDate { get; set; }
    /// <summary>"ecb" or "manual".</summary>
    public string? FxRateSource { get; set; }
    /// <summary><see cref="AmountMinor"/> in the group's currency at <see cref="FxRate"/>.</summary>
    public long? ConvertedAmountMinor { get; set; }
    /// <summary>The schedule and period pulse added this for; null for expenses people added.</summary>
    public Guid? RecurringScheduleId { get; set; }
    public DateOnly? RecurringPeriod { get; set; }
    public List<ExpensePayer> Payers { get; set; } = [];
    public List<ExpenseShare> Shares { get; set; } = [];
}

public sealed class ExpensePayer
{
    public Guid MemberId { get; set; }
    public long AmountMinor { get; set; }
}

public sealed class ExpenseShare
{
    public Guid MemberId { get; set; }
    public long AmountMinor { get; set; }
    /// <summary>The split input as entered (exact minor / basis points / weight); null for equal splits.</summary>
    public long? InputValue { get; set; }
}

public sealed class Settlement
{
    public Guid Id { get; set; }
    public Guid GroupId { get; set; }
    public Guid FromMemberId { get; set; }
    public Guid ToMemberId { get; set; }
    public required string Currency { get; set; }
    public long AmountMinor { get; set; }
    public Guid CreatedByUserId { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
    /// <summary>1 unit of <see cref="Currency"/> in the group's currency on the day it was recorded; null for the group's own currency.</summary>
    public decimal? FxRate { get; set; }
    public DateOnly? FxRateDate { get; set; }
    /// <summary>"ecb" or "manual".</summary>
    public string? FxRateSource { get; set; }
    /// <summary><see cref="AmountMinor"/> in the group's currency at <see cref="FxRate"/>.</summary>
    public long? ConvertedAmountMinor { get; set; }
    /// <summary>The money changed hands in the group's currency (ConvertedAmountMinor of it), settling this much of the debt's currency.</summary>
    public bool PaidInGroupCurrency { get; set; }
}

public sealed class AuditEntry
{
    public Guid Id { get; set; }
    public Guid GroupId { get; set; }
    public required string EntityType { get; set; }
    public Guid EntityId { get; set; }
    public required string Action { get; set; }
    public Guid ActorUserId { get; set; }
    public DateTimeOffset At { get; set; }
    public string? Before { get; set; }
    public string? After { get; set; }
}

public sealed class IdempotencyRecord
{
    public Guid UserId { get; set; }
    public required string Key { get; set; }
    public required string RequestHash { get; set; }
    public required string Status { get; set; }
    public int? StatusCode { get; set; }
    public string? ResponseBody { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}
