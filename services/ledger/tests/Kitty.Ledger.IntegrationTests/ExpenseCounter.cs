using System.Collections.Concurrent;
using System.Diagnostics.Metrics;

namespace Kitty.Ledger.IntegrationTests;

/// <summary>Records each kitty.expenses.created measurement, with its split_type, while it is alive.</summary>
public sealed class ExpenseCounter : IDisposable
{
    private readonly MeterListener _meters = new()
    {
        InstrumentPublished = (instrument, l) =>
        {
            if (instrument.Meter.Name == "Kitty.Ledger" && instrument.Name == "kitty.expenses.created") l.EnableMeasurementEvents(instrument);
        },
    };

    public ConcurrentBag<(long Value, string? SplitType)> Points { get; } = [];

    public ExpenseCounter()
    {
        _meters.SetMeasurementEventCallback<long>((_, value, tags, _) =>
        {
            string? split = null;
            foreach (var t in tags) if (t.Key == "split_type") split = t.Value as string;
            Points.Add((value, split));
        });
        _meters.Start();
    }

    public void Dispose() => _meters.Dispose();
}
