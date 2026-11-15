/** Keycloak RP-initiated logout URL: ends the SSO session too, so the next sign-in asks for credentials. */
export function keycloakLogoutUrl(issuer: string, idToken: string | undefined, appUrl: string, clientId?: string): string {
  const url = new URL(`${issuer}/protocol/openid-connect/logout`);
  if (idToken) url.searchParams.set("id_token_hint", idToken);
  else if (clientId) url.searchParams.set("client_id", clientId);
  url.searchParams.set("post_logout_redirect_uri", new URL("/", appUrl).toString());
  return url.toString();
}
