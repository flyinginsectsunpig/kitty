"use server";

import type { TableSessionDto } from "@kitty/api-client";
import { redirect } from "next/navigation";
import { isUuid } from "@kitty/core";
import { getLedger, problemCode } from "@/lib/ledger";

// Every action here runs as the signed-in user (getLedger sends them to sign in otherwise), and the ledger
// checks group membership and "host only" on each call. Ids from the browser are only references.

type Result = { session: TableSessionDto | null; error: string | null };
type MapResult = Result & { member: { id: string; displayName: string } | null };

const notFound: Result = { session: null, error: "not_found" };

function path(groupId: string, sessionId: string) {
  return { params: { path: { groupId, sessionId } } };
}

export async function createTableSession(form: FormData) {
  const groupId = String(form.get("groupId") ?? "");
  const id = String(form.get("sessionId") ?? "");
  const payerMemberId = String(form.get("payerMemberId") ?? "");
  if (!isUuid(groupId)) redirect("/groups");
  if (!isUuid(id) || !isUuid(payerMemberId)) redirect(`/groups/${groupId}/table/new?error=validation_failed`);

  const ledger = await getLedger();
  const { error } = await ledger.POST("/groups/{groupId}/table-sessions", {
    params: { path: { groupId } },
    body: { id, title: String(form.get("title") ?? ""), currency: String(form.get("currency") ?? "ZAR"), payerMemberId },
    headers: { "Idempotency-Key": String(form.get("idempotencyKey") ?? crypto.randomUUID()) },
  });
  if (error) redirect(`/groups/${groupId}/table/new?error=${encodeURIComponent(problemCode(error))}`);
  redirect(`/groups/${groupId}/table/${id}`);
}

export async function saveItems(
  groupId: string,
  sessionId: string,
  items: { id: string; description: string; quantity: number; lineTotalMinor: number }[],
): Promise<Result> {
  if (!isUuid(groupId) || !isUuid(sessionId)) return notFound;
  const { data, error } = await (await getLedger()).PUT("/groups/{groupId}/table-sessions/{sessionId}/items", {
    ...path(groupId, sessionId),
    body: { items },
  });
  return { session: data ?? null, error: error ? problemCode(error) : null };
}

/** The web screen manages a single extra: the tip. Zero removes it. */
export async function saveTip(groupId: string, sessionId: string, tipMinor: number): Promise<Result> {
  if (!isUuid(groupId) || !isUuid(sessionId)) return notFound;
  const charges = tipMinor > 0 ? [{ id: crypto.randomUUID(), kind: "tip", amountMinor: tipMinor }] : [];
  const { data, error } = await (await getLedger()).PUT("/groups/{groupId}/table-sessions/{sessionId}/charges", {
    ...path(groupId, sessionId),
    body: { charges },
  });
  return { session: data ?? null, error: error ? problemCode(error) : null };
}

export async function transition(groupId: string, sessionId: string, to: "lock" | "unlock" | "cancel"): Promise<Result> {
  if (!isUuid(groupId) || !isUuid(sessionId)) return notFound;
  const ledger = await getLedger();
  const call =
    to === "lock"
      ? ledger.POST("/groups/{groupId}/table-sessions/{sessionId}/lock", path(groupId, sessionId))
      : to === "unlock"
        ? ledger.POST("/groups/{groupId}/table-sessions/{sessionId}/unlock", path(groupId, sessionId))
        : ledger.POST("/groups/{groupId}/table-sessions/{sessionId}/cancel", path(groupId, sessionId));
  const { data, error } = await call;
  return { session: data ?? null, error: error ? problemCode(error) : null };
}

/**
 * Matches a guest to an existing member, or first adds them to the group by name (a placeholder they can
 * take over later). A null memberId with no name un-matches the guest.
 */
export async function mapGuest(
  groupId: string,
  sessionId: string,
  guestId: string,
  memberId: string | null,
  newName: string | null,
): Promise<MapResult> {
  if (!isUuid(groupId) || !isUuid(sessionId) || !isUuid(guestId) || (memberId !== null && !isUuid(memberId)))
    return { ...notFound, member: null };

  const ledger = await getLedger();
  let target = memberId;
  let added: MapResult["member"] = null;
  if (!target && newName) {
    const { data: member, error: createError } = await ledger.POST("/groups/{groupId}/members", {
      params: { path: { groupId } },
      body: { displayName: newName },
    });
    if (createError || !member) return { session: null, error: problemCode(createError), member: null };
    target = member.id;
    added = { id: member.id, displayName: member.displayName };
  }

  const { data, error } = await ledger.POST("/groups/{groupId}/table-sessions/{sessionId}/guests/{guestId}/map", {
    params: { path: { groupId, sessionId, guestId } },
    body: { memberId: target },
  });
  return { session: data ?? null, error: error ? problemCode(error) : null, member: added };
}

/** Confirms the bill; on success the host lands back on the group, where the new expense is. */
export async function confirmTable(groupId: string, sessionId: string): Promise<Result> {
  if (!isUuid(groupId) || !isUuid(sessionId)) return notFound;
  const { data, error } = await (await getLedger()).POST("/groups/{groupId}/table-sessions/{sessionId}/confirm", path(groupId, sessionId));
  if (!error && data?.expenseId) redirect(`/groups/${groupId}`);
  return { session: data ?? null, error: error ? problemCode(error) : null };
}
