namespace Kitty.Ledger.Features.Table;

/// <summary>
/// Tells everyone at the table that the session changed; clients re-fetch it. The status rides along so a
/// guest, whose access ends when the bill is confirmed or cancelled, still learns how it ended.
/// </summary>
public interface ITableNotifier
{
    Task NotifyAsync(Guid sessionId, int version, string status, CancellationToken ct);
}
