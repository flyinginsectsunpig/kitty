namespace Kitty.Ledger.Domain.Balances;

public static class LastSquare
{
    /// <summary>
    /// The rows after the last point where my running net was zero (all of them if it never was), in recorded order.
    /// Empty when I'm square now.
    /// </summary>
    public static IReadOnlyList<T> Since<T>(IReadOnlyList<(T Row, long MyDelta)> recordedOrder)
    {
        long running = 0;
        var start = 0;
        for (var i = 0; i < recordedOrder.Count; i++)
        {
            running += recordedOrder[i].MyDelta;
            if (running == 0) start = i + 1;
        }
        return recordedOrder.Skip(start).Select(r => r.Row).ToList();
    }
}
