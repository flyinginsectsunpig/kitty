import "server-only";
import { getToken } from "next-auth/jwt";
import { headers } from "next/headers";
import { refreshAccessToken, type AuthToken } from "./refresh";

/**
 * The caller's Keycloak access token, read from the encrypted session cookie on the server.
 * The proxy refreshes and re-saves the cookie; if this request still carries an expiring token
 * we refresh in memory too, so the ledger call never goes out with a dead token.
 */
export async function getAccessToken(): Promise<string | null> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET must be set.");

  const token = (await getToken({
    req: { headers: await headers() },
    secret,
    secureCookie: (process.env.AUTH_URL ?? "").startsWith("https://"),
  })) as AuthToken | null;
  if (!token || token.error) return null;

  const fresh = await refreshAccessToken(token, Math.floor(Date.now() / 1000));
  return fresh.error ? null : (fresh.accessToken ?? null);
}
