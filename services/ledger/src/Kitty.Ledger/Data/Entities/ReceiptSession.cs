namespace Kitty.Ledger.Data.Entities;

public static class SessionStatus
{
    public const string Open = "open";
    public const string Locked = "locked";
    public const string Confirmed = "confirmed";
    public const string Cancelled = "cancelled";
}

/// <summary>VAT is included in South African menu prices, so it is never an additive charge.</summary>
public static class ChargeKinds
{
    public const string Tip = "tip";
    public const string Service = "service";
    public const string Delivery = "delivery";
    public const string Other = "other";

    public static readonly IReadOnlySet<string> All = new HashSet<string>(StringComparer.Ordinal) { Tip, Service, Delivery, Other };
}

public static class ClaimantKinds
{
    public const string Member = "member";
    public const string Guest = "guest";
}

/// <summary>A bill being split live at the table: open → locked → confirmed (or cancelled).</summary>
public sealed class ReceiptSession
{
    public Guid Id { get; set; }
    public Guid GroupId { get; set; }
    public Guid HostUserId { get; set; }
    public Guid PayerMemberId { get; set; }
    public required string Currency { get; set; }
    public required string Title { get; set; }
    public required string Status { get; set; }
    public Guid? ExpenseId { get; set; }
    public int Version { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public List<ReceiptItem> Items { get; set; } = [];
    public List<ReceiptCharge> Charges { get; set; } = [];
    public List<Guest> Guests { get; set; } = [];
}

public sealed class ReceiptItem
{
    public Guid Id { get; set; }
    public Guid SessionId { get; set; }
    public required string Description { get; set; }
    public int Quantity { get; set; }
    public long LineTotalMinor { get; set; }
    public int Position { get; set; }
    public List<ItemClaim> Claims { get; set; } = [];
}

public sealed class ReceiptCharge
{
    public Guid Id { get; set; }
    public Guid SessionId { get; set; }
    public required string Kind { get; set; }
    public long AmountMinor { get; set; }
}

/// <summary>Composite key (item, kind, claimant): two people can share an item; one person can't claim it twice.</summary>
public sealed class ItemClaim
{
    public Guid ItemId { get; set; }
    public required string ClaimantKind { get; set; }
    public Guid ClaimantId { get; set; }
}

/// <summary>Someone at the table without an account. Only a hash of their token is stored.</summary>
public sealed class Guest
{
    public Guid Id { get; set; }
    public Guid SessionId { get; set; }
    public required string DisplayName { get; set; }
    public required string TokenHash { get; set; }
    public Guid? MappedMemberId { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
}
