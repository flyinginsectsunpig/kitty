using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Domain.Fx;
using Kitty.Ledger.Infrastructure.Fx;

namespace Kitty.Ledger.Features.Fx;

/// <summary>What exchange rate an expense or settlement gets.</summary>
public abstract record RateDecision
{
    private RateDecision() { }

    /// <summary>It's in the group's own currency: no rate.</summary>
    public sealed record None : RateDecision;

    /// <summary>A rate to store. EcbDate is the ECB publication date (null when typed); Source is "ecb" or "manual".</summary>
    public sealed record Rate(decimal Value, DateOnly? EcbDate, string Source) : RateDecision;

    /// <summary>Foreign, nothing typed, and pulse couldn't answer.</summary>
    public sealed record Missing : RateDecision;

    public sealed record Invalid(string Detail) : RateDecision;
}

/// <summary>
/// Decides a row's rate (spec §3.2). A rate the client sends was typed by a person ("manual"). Otherwise an existing
/// rate is kept while the currency and date stay the same, and anything else asks pulse for the ECB rate of that date.
/// </summary>
public sealed class ExpenseRates(IFxRates fx)
{
    public async Task<RateDecision> DecideAsync(string currency, string groupCurrency, DateOnly occurredOn, string? sentRate,
        Expense? existing, CancellationToken ct)
    {
        if (currency == groupCurrency)
            return sentRate is null ? new RateDecision.None() : new RateDecision.Invalid("An expense in the group's own currency has no exchange rate.");

        if (sentRate is not null)
            return FxRate.TryParse(sentRate, out var typed)
                ? new RateDecision.Rate(typed, null, FxEndpoints.ManualSource)
                : new RateDecision.Invalid("The exchange rate must be a number above 0 and at most 1,000,000, with up to 10 decimal places.");

        if (existing is { FxRate: { } kept } && existing.Currency.Trim() == currency && existing.OccurredOn == occurredOn)
            return new RateDecision.Rate(kept, existing.FxRateDate, existing.FxRateSource ?? FxEndpoints.EcbSource);

        var quote = await fx.GetAsync(currency, groupCurrency, occurredOn, ct);
        return quote is null ? new RateDecision.Missing() : new RateDecision.Rate(quote.Rate, quote.RateDate, FxEndpoints.EcbSource);
    }
}
