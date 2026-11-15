using System.Threading.RateLimiting;
using Kitty.Ledger.Infrastructure.Errors;

namespace Kitty.Ledger.Infrastructure.RateLimiting;

/// <summary>
/// Fixed-window limit on mutating requests per user (<c>Ledger:WriteRateLimitPerMinute</c>, default 60).
/// In-memory: correct for the single replica of phase 1; Redis-backed when the ledger scales out.
/// </summary>
public static class WriteRateLimiting
{
    public const int DefaultPerMinute = 60;

    public static IServiceCollection AddWriteRateLimiting(this IServiceCollection services, IConfiguration config)
    {
        var perMinute = config.GetValue("Ledger:WriteRateLimitPerMinute", DefaultPerMinute);

        services.AddRateLimiter(options =>
        {
            options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(ctx =>
            {
                var method = ctx.Request.Method;
                var mutating = HttpMethods.IsPost(method) || HttpMethods.IsPut(method)
                               || HttpMethods.IsPatch(method) || HttpMethods.IsDelete(method);
                var sub = ctx.User.FindFirst("sub")?.Value;

                return mutating && sub is not null
                    ? RateLimitPartition.GetFixedWindowLimiter(sub, _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = perMinute,
                        Window = TimeSpan.FromMinutes(1),
                        QueueLimit = 0,
                    })
                    : RateLimitPartition.GetNoLimiter("unlimited");
            });

            options.OnRejected = async (ctx, ct) =>
            {
                ctx.HttpContext.Response.Headers.RetryAfter = "60";
                await ApiError.Problem(StatusCodes.Status429TooManyRequests, ErrorCodes.RateLimited,
                    "Too many changes in a minute. Try again shortly.").ExecuteAsync(ctx.HttpContext);
            };
        });

        return services;
    }
}
