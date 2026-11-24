using System.Collections.Concurrent;
using Kitty.Ledger.Infrastructure.Fx;

namespace Kitty.Ledger.IntegrationTests;

/// <summary>Stands in for pulse. Unknown pairs and dates are "unavailable" (null), as is everything while it's down.</summary>
public sealed class FakeFxRates : IFxRates
{
    private readonly ConcurrentDictionary<(string From, string To, DateOnly Date), FxQuote> _quotes = new();
    private volatile bool _down;

    public void Set(string from, string to, DateOnly date, decimal rate, DateOnly? rateDate = null) =>
        _quotes[(from, to, date)] = new FxQuote(rate, rateDate ?? date);

    /// <summary>pulse is unreachable until the returned scope is disposed.</summary>
    public IDisposable GoDown()
    {
        _down = true;
        return new Scope(() => _down = false);
    }

    public Task<FxQuote?> GetAsync(string from, string to, DateOnly date, CancellationToken ct) =>
        Task.FromResult(_down ? null : _quotes.GetValueOrDefault((from, to, date)));

    private sealed class Scope(Action dispose) : IDisposable
    {
        public void Dispose() => dispose();
    }
}
