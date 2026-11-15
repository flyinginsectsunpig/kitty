namespace Kitty.Ledger.Features.Table;

/// <summary>Tells everyone at the table that the session changed; clients re-fetch it.</summary>
public interface ITableNotifier
{
    Task NotifyAsync(Guid sessionId, int version, CancellationToken ct);
}

public sealed class NoopTableNotifier : ITableNotifier
{
    public Task NotifyAsync(Guid sessionId, int version, CancellationToken ct) => Task.CompletedTask;
}
