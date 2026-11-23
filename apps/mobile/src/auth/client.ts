import {
  AuthRequest,
  exchangeCodeAsync,
  fetchDiscoveryAsync,
  makeRedirectUri,
  refreshAsync,
  TokenError,
  type DiscoveryDocument,
  type TokenResponse,
} from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import { SessionRejected, type Tokens } from "./tokens";

/** What the app needs from Keycloak. Tests pass a fake. */
export type AuthClient = {
  /** Opens Keycloak's login in the system browser. Null when the user cancels or backs out. */
  signIn(): Promise<Tokens | null>;
  /** Throws SessionRejected when Keycloak refuses; anything else (no signal) is passed on unchanged. */
  refresh(refreshToken: string): Promise<Tokens>;
  /** Ends the Keycloak session too, so the next sign-in asks again. */
  signOut(idToken: string | undefined): Promise<void>;
};

export const CLIENT_ID = "kitty-mobile";
export const REDIRECT_URI = makeRedirectUri({ scheme: "kitty", path: "auth/callback" });

function toTokens(t: TokenResponse): Tokens {
  if (!t.refreshToken) throw new Error("Keycloak returned no refresh token.");
  return {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    expiresAt: t.issuedAt + (t.expiresIn ?? 0),
    ...(t.idToken ? { idToken: t.idToken } : {}),
  };
}

/** Authorization Code + PKCE against the kitty realm, through the system browser. */
export function createKeycloakClient(issuer: string): AuthClient {
  let discovery: Promise<DiscoveryDocument> | null = null;
  const discover = () => (discovery ??= fetchDiscoveryAsync(issuer).catch((e: unknown) => {
    discovery = null; // offline at start-up: try again next time
    throw e;
  }));

  return {
    async signIn() {
      const doc = await discover();
      const request = new AuthRequest({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI, scopes: ["openid", "profile", "email"], usePKCE: true });
      const result = await request.promptAsync(doc);
      if (result.type !== "success") {
        if (result.type === "error") throw new Error(result.error?.message ?? "Sign-in failed.");
        return null; // cancel, dismiss, locked
      }
      const code = result.params.code;
      if (!code || !request.codeVerifier) throw new Error("Sign-in returned no code.");
      return toTokens(await exchangeCodeAsync({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI, code, extraParams: { code_verifier: request.codeVerifier } }, doc));
    },

    async refresh(refreshToken) {
      let response: TokenResponse;
      try {
        response = await refreshAsync({ clientId: CLIENT_ID, refreshToken }, await discover());
      } catch (e) {
        // An OAuth error answer (invalid_grant: expired, revoked, signed out elsewhere) is final; no signal is not.
        if (e instanceof TokenError) throw new SessionRejected(e.code);
        throw e;
      }
      if (!response.refreshToken) throw new SessionRejected("no refresh token");
      return toTokens(response);
    },

    async signOut(idToken) {
      const doc = await discover();
      if (!doc.endSessionEndpoint) return;
      const url = new URL(doc.endSessionEndpoint);
      url.searchParams.set("client_id", CLIENT_ID);
      url.searchParams.set("post_logout_redirect_uri", REDIRECT_URI);
      if (idToken) url.searchParams.set("id_token_hint", idToken);
      await WebBrowser.openAuthSessionAsync(url.toString(), REDIRECT_URI);
    },
  };
}
