/** What we keep in the encrypted Auth.js session cookie. Never sent to the browser as readable data. */
export type AuthToken = {
  accessToken?: string;
  refreshToken?: string;
  /** Access-token expiry, seconds since epoch. */
  expiresAt?: number;
  error?: "RefreshAccessTokenError";
  [claim: string]: unknown;
};

export type KeycloakClientConfig = { issuer: string; clientId: string; clientSecret: string };

/** Refresh this many seconds before expiry so a request never carries a token that dies in flight. */
export const REFRESH_SKEW_SECONDS = 30;

export function keycloakConfigFromEnv(): KeycloakClientConfig {
  const issuer = process.env.AUTH_KEYCLOAK_ISSUER;
  const clientId = process.env.AUTH_KEYCLOAK_ID;
  const clientSecret = process.env.AUTH_KEYCLOAK_SECRET;
  if (!issuer || !clientId || !clientSecret)
    throw new Error("AUTH_KEYCLOAK_ISSUER, AUTH_KEYCLOAK_ID and AUTH_KEYCLOAK_SECRET must be set.");
  return { issuer, clientId, clientSecret };
}

/**
 * Returns the token unchanged while it is fresh; otherwise exchanges the refresh token with Keycloak.
 * On failure the token is marked with error = "RefreshAccessTokenError" and the app sends the user to sign in.
 */
export async function refreshAccessToken(
  token: AuthToken,
  now: number,
  fetchFn: typeof fetch = fetch,
  cfg: KeycloakClientConfig = keycloakConfigFromEnv(),
): Promise<AuthToken> {
  if (token.expiresAt !== undefined && token.expiresAt - REFRESH_SKEW_SECONDS > now) return token;
  if (!token.refreshToken) return { ...token, error: "RefreshAccessTokenError" };

  try {
    const response = await fetchFn(`${cfg.issuer}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }).toString(),
    });
    if (!response.ok) return { ...token, error: "RefreshAccessTokenError" };

    const body = (await response.json()) as { access_token: string; expires_in: number; refresh_token?: string };
    const { error: _cleared, ...rest } = token;
    return {
      ...rest,
      accessToken: body.access_token,
      expiresAt: now + body.expires_in,
      refreshToken: body.refresh_token ?? token.refreshToken,
    };
  } catch {
    return { ...token, error: "RefreshAccessTokenError" };
  }
}
