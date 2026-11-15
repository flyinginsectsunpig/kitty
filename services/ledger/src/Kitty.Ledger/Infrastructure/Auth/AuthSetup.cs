using Microsoft.AspNetCore.Authentication.JwtBearer;

namespace Kitty.Ledger.Infrastructure.Auth;

public static class AuthSetup
{
    /// <summary>Validates Keycloak access tokens: issuer = <c>Auth:Authority</c>, audience = <c>Auth:Audience</c>.</summary>
    public static IServiceCollection AddLedgerAuth(this IServiceCollection services, IConfiguration config, IHostEnvironment env)
    {
        var authority = config["Auth:Authority"]
            ?? throw new InvalidOperationException("Auth:Authority is not configured (Keycloak realm URL).");
        var audience = config["Auth:Audience"] ?? "kitty-ledger";

        services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
            .AddJwtBearer(o =>
            {
                o.Authority = authority;
                o.Audience = audience;
                o.MapInboundClaims = false; // keep "sub", "name", "email" as Keycloak sends them
                o.RequireHttpsMetadata = !env.IsDevelopment() && authority.StartsWith("https", StringComparison.Ordinal);
                o.TokenValidationParameters.ValidAudience = audience;
                o.TokenValidationParameters.NameClaimType = "name";
            });

        services.AddAuthorizationBuilder()
            .SetFallbackPolicy(new Microsoft.AspNetCore.Authorization.AuthorizationPolicyBuilder()
                .RequireAuthenticatedUser().Build());

        services.AddScoped<ICurrentUser, CurrentUser>();
        return services;
    }
}
