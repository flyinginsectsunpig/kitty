namespace Kitty.Ledger.Infrastructure.Fx;

/// <summary>An ECB rate: 1 unit of the from-currency = <see cref="Rate"/> of the to-currency, as published on <see cref="RateDate"/>.</summary>
public sealed record FxQuote(decimal Rate, DateOnly RateDate);

/// <summary>Exchange rates from pulse. Null means pulse couldn't answer; callers decide what that means for them.</summary>
public interface IFxRates
{
    Task<FxQuote?> GetAsync(string from, string to, DateOnly date, CancellationToken ct);
}
