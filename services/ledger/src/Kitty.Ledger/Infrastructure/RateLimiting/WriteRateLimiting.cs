using System.Security.Cryptography;
using System.Text;
using System.Threading.RateLimiting;
using Kitty.Ledger.Infrastructure.Errors;

namespace Kitty.Ledger.Infrastructure.RateLimiting;

/// <summary>
/// Fixed-window limits (in-memory: correct for phase 1's single replica):
/// signed-in users' writes (<c>Ledger:WriteRateLimitPerMinute</c>, default 60), guests' claims (per token, 120/min),
/// and anonymous guest joins per client IP (<c>Ledger:GuestJoinsPerMinute</c>, default 10).
/// </summary>
public static class WriteRateLimiting
{
    public const int DefaultPerMinute = 60;
    public const int GuestClaimsPerMinute = 120;
    public const int DefaultGuestJoinsPerMinute = 10;
    public const string GuestJoinPolicy = "guest-join";

    public static IServiceCollection AddWriteRateLimiting(this IServiceCollection services, IConfiguration config)
    {
        var perMinute = config.GetValue("Ledger:WriteRateLimitPerMinute", DefaultPerMinute);
        var joinsPerMinute = config.GetValue("Ledger:GuestJoinsPerMinute", DefaultGuestJoinsPerMinute);

        services.AddRateLimiter(options =>
        {
            options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(ctx =>
            {
                var method = ctx.Request.Method;
                var mutating = HttpMethods.IsPost(method) || HttpMethods.IsPut(method)
                               || HttpMethods.IsPatch(method) || HttpMethods.IsDelete(method);
                if (!mutating) return RateLimitPartition.GetNoLimiter("reads");

                if (ctx.User.FindFirst("sub")?.Value is { } sub) return Window("user:" + sub, perMinute);

                var header = ctx.Request.Headers.Authorization.ToString();
                return header.StartsWith("Guest ", StringComparison.Ordinal)
                    ? Window("guest:" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(header))), GuestClaimsPerMinute)
                    : RateLimitPartition.GetNoLimiter("anonymous");
            });

            options.AddPolicy(GuestJoinPolicy, ctx =>
                Window("join:" + (ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown"), joinsPerMinute));

            options.OnRejected = async (ctx, ct) =>
            {
                ctx.HttpContext.Response.Headers.RetryAfter = "60";
                await ApiError.Problem(StatusCodes.Status429TooManyRequests, ErrorCodes.RateLimited,
                    "Too many changes in a minute. Try again shortly.").ExecuteAsync(ctx.HttpContext);
            };
        });

        return services;
    }

    private static RateLimitPartition<string> Window(string key, int permits) =>
        RateLimitPartition.GetFixedWindowLimiter(key, _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = permits,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
        });
}
