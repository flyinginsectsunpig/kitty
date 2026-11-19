import "server-only";
import {
  createAnonymousLedgerClient,
  createGuestLedgerClient,
  type LedgerClient,
  type ListenTokenDto,
  type TableSessionDto,
} from "@kitty/api-client";
import { cookies } from "next/headers";
import { getAccessToken } from "@/auth/token";
import { isUuid } from "./ids";
import { getLedger, problemCode } from "./ledger";

/** A way into one table: as a signed-in member of its group, or as a guest holding that table's cookie. */
type Access = { kind: "member"; ledger: LedgerClient; groupId: string } | { kind: "guest"; ledger: LedgerClient };
type Outcome<T> = { data?: T; error?: unknown; response: Response };

export type TableLoad =
  | { status: "ok"; access: "member" | "guest"; session: TableSessionDto }
  /** The viewer had guest access to this bill and it has ended (confirmed, cancelled or expired). */
  | { status: "closed" }
  /** No way in yet: offer to join as a guest or to sign in. */
  | { status: "none" };

const guestCookie = (sessionId: string) => `kitty_guest_${sessionId}`;

function ledgerUrl(): string {
  const url = process.env.LEDGER_URL;
  if (!url) throw new Error("LEDGER_URL must be set.");
  return url;
}

/** The ledger hub as browsers reach it (dev: the ledger directly; production: Caddy's /api). */
export function hubUrl(): string {
  return `${process.env.LEDGER_PUBLIC_URL ?? ledgerUrl()}/hubs/table`;
}

/** The link behind the QR code. The group id lets signed-in members be recognised as themselves. */
export function tableLink(sessionId: string, groupId: string): string {
  return `${process.env.AUTH_URL ?? ""}/t/${sessionId}?g=${groupId}`;
}

async function accessOptions(sessionId: string, groupId: string | null): Promise<Access[]> {
  const options: Access[] = [];
  if (isUuid(groupId) && (await getAccessToken())) options.push({ kind: "member", ledger: await getLedger(), groupId });
  const guestToken = (await cookies()).get(guestCookie(sessionId))?.value;
  if (guestToken) options.push({ kind: "guest", ledger: createGuestLedgerClient(ledgerUrl(), guestToken) });
  return options;
}

/**
 * Tries each way in, member first, and moves on only when the ledger answers "not found" — which is what a
 * signed-in person who isn't in this group gets, before their guest cookie is tried. The ledger does the
 * authorizing every time; nothing sent by the browser is trusted for access.
 */
async function firstFound<T>(
  sessionId: string,
  groupId: string | null,
  call: (access: Access) => Promise<Outcome<T>>,
): Promise<{ access: Access; outcome: Outcome<T> } | null> {
  if (!isUuid(sessionId)) return null;
  let last: { access: Access; outcome: Outcome<T> } | null = null;
  for (const access of await accessOptions(sessionId, groupId)) {
    last = { access, outcome: await call(access) };
    if (last.outcome.response.status !== 404) break;
  }
  return last;
}

/** The bill as the person making this request may see it. Throws if the ledger itself fails. */
export async function loadTable(sessionId: string, groupId: string | null): Promise<TableLoad> {
  const found = await firstFound<TableSessionDto>(sessionId, groupId, (access) =>
    access.kind === "member"
      ? access.ledger.GET("/groups/{groupId}/table-sessions/{sessionId}", { params: { path: { groupId: access.groupId, sessionId } } })
      : access.ledger.GET("/guest/table-sessions/{sessionId}", { params: { path: { sessionId } } }),
  );
  if (!found) return { status: "none" };

  const { access, outcome } = found;
  if (outcome.data) return { status: "ok", access: access.kind, session: outcome.data };
  if (outcome.response.status === 404) return { status: access.kind === "guest" ? "closed" : "none" };
  throw new Error(`Ledger request failed (${outcome.response.status}).`);
}

/**
 * A read-only token that lets the browser listen for changes to this one bill. The viewer's real credentials
 * (Keycloak token or guest token) never leave the server. Null when there is nothing they may listen to.
 */
export async function listenTokenFor(sessionId: string, groupId: string | null): Promise<string | null> {
  const found = await firstFound<ListenTokenDto>(sessionId, groupId, (access) =>
    access.kind === "member"
      ? access.ledger.GET("/groups/{groupId}/table-sessions/{sessionId}/listen-token", { params: { path: { groupId: access.groupId, sessionId } } })
      : access.ledger.GET("/guest/table-sessions/{sessionId}/listen-token", { params: { path: { sessionId } } }),
  );
  if (!found || found.outcome.response.status === 404) return null;
  if (!found.outcome.data) throw new Error(`Ledger request failed (${found.outcome.response.status}).`);
  return found.outcome.data.token;
}

/** Claims or un-claims an item for the person making this request; returns an error code or null. */
export async function setClaim(sessionId: string, groupId: string | null, itemId: string, claimed: boolean): Promise<string | null> {
  if (!isUuid(itemId)) return "not_found";
  const found = await firstFound<unknown>(sessionId, groupId, (access) => {
    if (access.kind === "member") {
      const options = { params: { path: { groupId: access.groupId, sessionId, itemId } } };
      return claimed
        ? access.ledger.PUT("/groups/{groupId}/table-sessions/{sessionId}/items/{itemId}/claim", options)
        : access.ledger.DELETE("/groups/{groupId}/table-sessions/{sessionId}/items/{itemId}/claim", options);
    }
    const options = { params: { path: { sessionId, itemId } } };
    return claimed
      ? access.ledger.PUT("/guest/table-sessions/{sessionId}/items/{itemId}/claim", options)
      : access.ledger.DELETE("/guest/table-sessions/{sessionId}/items/{itemId}/claim", options);
  });
  if (!found || found.outcome.response.status === 404) return "not_found";
  return found.outcome.response.ok ? null : problemCode(found.outcome.error);
}

/** Joins as a guest and keeps the guest token in an httpOnly cookie scoped to this table's pages. */
export async function joinAsGuest(sessionId: string, displayName: string): Promise<string | null> {
  if (!isUuid(sessionId)) return "not_found";
  const { data, error } = await createAnonymousLedgerClient(ledgerUrl()).POST("/table-sessions/{sessionId}/join", {
    params: { path: { sessionId } },
    body: { displayName },
  });
  if (error || !data) return problemCode(error);

  (await cookies()).set(guestCookie(sessionId), data.guestToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: (process.env.AUTH_URL ?? "").startsWith("https://"),
    path: `/t/${sessionId}`,
    expires: new Date(data.expiresAt),
  });
  return null;
}
