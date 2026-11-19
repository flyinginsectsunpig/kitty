import type { TableSession } from "./table-state";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function url(sessionId: string, groupId: string | null, what: "state" | "listen-token"): string {
  return `/t/${encodeURIComponent(sessionId)}/${what}${groupId ? `?g=${encodeURIComponent(groupId)}` : ""}`;
}

/**
 * Browser-side reads for a table screen, served by this app's own Route Handlers (which hold the viewer's
 * credentials). `null` means the viewer can no longer see the bill; a failed request throws so the caller
 * retries instead of treating the table as closed.
 */
export async function fetchTableState(sessionId: string, groupId: string | null, fetchFn: Fetch = fetch): Promise<TableSession | null> {
  const response = await fetchFn(url(sessionId, groupId, "state"), { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Table refresh failed (${response.status}).`);
  return (await response.json()) as TableSession;
}

/** A read-only token for the live connection to this one bill, or null when there is nothing to listen to. */
export async function fetchListenToken(sessionId: string, groupId: string | null, fetchFn: Fetch = fetch): Promise<string | null> {
  const response = await fetchFn(url(sessionId, groupId, "listen-token"), { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Listen token request failed (${response.status}).`);
  return ((await response.json()) as { token: string }).token;
}
