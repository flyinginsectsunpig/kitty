using System.Globalization;
using Grpc.Core;
using Kitty.Contracts.Fx.V1;
using Kitty.Ledger.Domain.Fx;

namespace Kitty.Ledger.Infrastructure.Fx;

/// <summary>Asks pulse over gRPC. Any failure (down, slow, refused) is logged and returned as null.</summary>
public sealed class GrpcFxRates(RatesService.RatesServiceClient client, ILogger<GrpcFxRates> log) : IFxRates
{
    private static readonly TimeSpan Deadline = TimeSpan.FromSeconds(3);

    public async Task<FxQuote?> GetAsync(string from, string to, DateOnly date, CancellationToken ct)
    {
        try
        {
            var res = await client.GetRateAsync(
                new GetRateRequest { Base = from, Quote = to, Date = date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) },
                deadline: DateTime.UtcNow.Add(Deadline), cancellationToken: ct);

            if (!FxRate.TryParse(res.Rate, out var rate)
                || !DateOnly.TryParseExact(res.RateDate, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var rateDate))
            {
                log.LogWarning("pulse returned an unusable rate {Rate} for {RateDate}", res.Rate, res.RateDate);
                return null;
            }
            return new FxQuote(rate, rateDate);
        }
        catch (RpcException e)
        {
            log.LogWarning("pulse couldn't give a {From}→{To} rate for {Date}: {Status}", from, to, date, e.StatusCode);
            return null;
        }
    }
}

public static class FxRatesSetup
{
    /// <summary>Registers the pulse client. Fx:Url is required (fail fast at startup, not on the first expense).</summary>
    public static IServiceCollection AddFxRates(this IServiceCollection services, IConfiguration config)
    {
        var url = config["Fx:Url"];
        if (string.IsNullOrWhiteSpace(url)) throw new InvalidOperationException("Fx:Url (pulse's address) is required.");
        services.AddGrpcClient<RatesService.RatesServiceClient>(o => o.Address = new Uri(url));
        services.AddScoped<IFxRates, GrpcFxRates>();
        return services;
    }
}
