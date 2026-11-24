using Kitty.Ledger.Data;
using Kitty.Ledger.Domain;
using Kitty.Ledger.Domain.Fx;
using Kitty.Ledger.Infrastructure.Errors;
using Kitty.Ledger.Infrastructure.Fx;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Fx;

/// <summary>1 <c>currency</c> = <see cref="Rate"/> of the group's currency, from the ECB's rate published on <see cref="RateDate"/>.</summary>
public sealed record FxRateDto(string Rate, DateOnly RateDate, string Source);

public static class FxEndpoints
{
    public const string EcbSource = "ecb";
    public const string ManualSource = "manual";

    /// <summary>The rate the forms pre-fill (and show) for a foreign-currency expense or settlement.</summary>
    public static void MapFx(this RouteGroupBuilder group) =>
        group.MapGet("/fx-rate", GetAsync).WithTags("Exchange rates").WithName("GetFxRate").Produces<FxRateDto>();

    private static async Task<IResult> GetAsync(Guid groupId, string currency, DateOnly date, LedgerDbContext db, IFxRates fx,
        CancellationToken ct)
    {
        if (!Currencies.IsSupported(currency)) return ApiError.BadRequest(ErrorCodes.CurrencyUnsupported);
        var groupCurrency = (await db.Groups.Where(g => g.Id == groupId).Select(g => g.BaseCurrency).SingleAsync(ct)).Trim();
        if (currency == groupCurrency) return ApiError.Validation("That's the group's own currency: it has no exchange rate.");

        var quote = await fx.GetAsync(currency, groupCurrency, date, ct);
        return quote is null
            ? ApiError.Problem(StatusCodes.Status503ServiceUnavailable, ErrorCodes.FxRateUnavailable,
                "Couldn't get the exchange rate. Type the rate instead.")
            : Results.Ok(new FxRateDto(FxRate.Format(quote.Rate), quote.RateDate, EcbSource));
    }
}
