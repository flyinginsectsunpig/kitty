namespace Kitty.Ledger.Infrastructure;

public static class ClockExtensions
{
    /// <summary>
    /// UTC now truncated to microseconds — Postgres timestamptz precision — so a timestamp read back
    /// from the database equals the one written (needed for keyset cursors).
    /// </summary>
    public static DateTimeOffset NowMicros(this TimeProvider clock)
    {
        var now = clock.GetUtcNow();
        return new DateTimeOffset(now.UtcTicks - now.UtcTicks % 10, TimeSpan.Zero);
    }
}
