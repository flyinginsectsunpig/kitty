using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Text;
using Confluent.Kafka;
using Kitty.Ledger.Domain.Splits;

namespace Kitty.Ledger.Infrastructure.Telemetry;

/// <summary>
/// The ledger's own OpenTelemetry instruments (phase 5b). Exported only when OTEL_EXPORTER_OTLP_ENDPOINT is set
/// (Kitty.ServiceDefaults); otherwise they cost nothing. Labels never carry user or group ids.
/// </summary>
public static class LedgerTelemetry
{
    /// <summary>The ActivitySource and Meter name, registered in Kitty.ServiceDefaults.</summary>
    public const string Name = "Kitty.Ledger";

    /// <summary>The W3C trace-context header Kafka messages carry (and outbox rows store).</summary>
    public const string TraceParentHeader = "traceparent";

    public static readonly ActivitySource Source = new(Name);
    public static readonly Meter Meter = new(Name);

    /// <summary>Expenses added, by split type (equal, exact, percent, shares, itemized…).</summary>
    public static readonly Counter<long> ExpensesCreated = Meter.CreateCounter<long>("kitty.expenses.created");

    /// <summary>Counts one saved expense, from any path: the expense form, a table bill, a recurring schedule.</summary>
    public static void CountExpenseCreated(SplitMethod split) =>
        ExpensesCreated.Add(1, new KeyValuePair<string, object?>("split_type", split.ToString().ToLowerInvariant()));

    /// <summary>The current trace as a W3C traceparent, or null outside a W3C trace.</summary>
    public static string? CurrentTraceParent() =>
        Activity.Current is { IdFormat: ActivityIdFormat.W3C } a ? a.Id : null;

    /// <summary>The traceparent in a Kafka message's headers, if any.</summary>
    public static string? TraceParentOf(Headers? headers) =>
        headers is not null && headers.TryGetLastBytes(TraceParentHeader, out var bytes) ? Encoding.UTF8.GetString(bytes) : null;

    /// <summary>Starts a span whose parent is the given traceparent (a new trace if it's missing or malformed).</summary>
    public static Activity? StartLinked(string name, ActivityKind kind, string? traceParent) =>
        traceParent is not null && ActivityContext.TryParse(traceParent, null, out var parent)
            ? Source.StartActivity(name, kind, parent)
            : Source.StartActivity(name, kind);
}
