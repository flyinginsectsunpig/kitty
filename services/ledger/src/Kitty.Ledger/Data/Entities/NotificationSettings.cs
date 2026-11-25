namespace Kitty.Ledger.Data.Entities;

/// <summary>What a person wants to be told, on which channel. Defaults: push for expenses and payments, nothing else.</summary>
public sealed class NotificationSettings
{
    public Guid UserId { get; set; }
    public bool ExpensePush { get; set; } = true;
    public bool ExpenseEmail { get; set; }
    public bool PaymentPush { get; set; } = true;
    public bool PaymentEmail { get; set; }
    public bool WeeklyPush { get; set; }
    public bool WeeklyEmail { get; set; }
    /// <summary>Bumped on every publish, so pulse keeps the newest state.</summary>
    public long Version { get; set; }
}

/// <summary>A weekly summary was queued for this person and ISO week (so a repeated run doesn't send it twice).</summary>
public sealed class WeeklySummary
{
    public Guid UserId { get; set; }
    public required string Week { get; set; }
    public DateTimeOffset QueuedAt { get; set; }
}

/// <summary>A phone's Firebase push token. A token belongs to one person (the last one signed in on that phone).</summary>
public sealed class PushDevice
{
    public required string Token { get; set; }
    public Guid UserId { get; set; }
    public required string Platform { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset LastSeenAt { get; set; }
}
