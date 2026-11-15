using System.Security.Claims;
using System.Security.Cryptography;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace Kitty.Ledger.IntegrationTests;

/// <summary>Issues access tokens shaped like Keycloak's, signed with a key only the tests know.</summary>
public static class TestTokens
{
    public const string Issuer = "https://test-issuer";
    public const string Audience = "kitty-ledger";

    public static readonly RsaSecurityKey SigningKey = new(RSA.Create(2048)) { KeyId = "test-key" };

    public static string For(string sub, string name, string email, string audience = Audience) =>
        new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = Issuer,
            Audience = audience,
            Expires = DateTime.UtcNow.AddMinutes(5),
            Subject = new ClaimsIdentity([new("sub", sub), new("name", name), new("email", email)]),
            SigningCredentials = new SigningCredentials(SigningKey, SecurityAlgorithms.RsaSha256),
        });
}
