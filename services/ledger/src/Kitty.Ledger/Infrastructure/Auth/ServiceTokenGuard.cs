using Kitty.Ledger.Infrastructure.Errors;

namespace Kitty.Ledger.Infrastructure.Auth;

/// <summary>
/// pulse's client-credentials token is for its gRPC calls only. It has no person behind it, so every other route
/// refuses it (otherwise it would be mirrored as a "user" and could act like one).
/// </summary>
public sealed class ServiceTokenGuard(RequestDelegate next)
{
    public const string PulseClientId = "kitty-pulse";
    public const string GrpcPathPrefix = "/kitty.ledger.v1.";

    public async Task InvokeAsync(HttpContext http)
    {
        if (http.User.FindFirst("azp")?.Value == PulseClientId
            && !(http.Request.Path.Value ?? "").StartsWith(GrpcPathPrefix, StringComparison.Ordinal))
        {
            await ApiError.Problem(StatusCodes.Status403Forbidden, ErrorCodes.ServiceTokenNotAllowed).ExecuteAsync(http);
            return;
        }
        await next(http);
    }
}
