import { isIP } from "node:net";

/**
 * The header that tells the ledger who is really calling, for its per-client limits. Calls from this server
 * otherwise all come from one address. Only trust it behind a proxy that sets the header itself (Caddy in
 * deploy/compose); the last entry is the one that proxy added, so a value the client sent can't stand in for it.
 */
export function forwardedFor(headers: Headers, trustProxy: boolean): Record<string, string> {
  if (!trustProxy) return {};
  const last = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ?? "";
  return isIP(last) ? { "X-Forwarded-For": last } : {};
}
