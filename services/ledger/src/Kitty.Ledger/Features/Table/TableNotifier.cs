namespace Kitty.Ledger.Features.Table;

/// <summary>Tells everyone at the table that the session changed; clients re-fetch it.</summary>
public interface ITableNotifier
{
    Task NotifyAsync(Guid sessionId, int version, CancellationToken ct);
}
