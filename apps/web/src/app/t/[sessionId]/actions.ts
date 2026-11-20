"use server";

import type { TableSessionDto } from "@kitty/api-client";
import { redirect } from "next/navigation";
import { isUuid } from "@/lib/ids";
import { joinAsGuest, loadTable, setClaim } from "@/lib/table";

/**
 * Claims or un-claims an item for whoever is making this request, then returns the bill as it now stands.
 * Access is worked out again from the request's own cookies on every call; the ids are only references.
 */
export async function toggleClaim(
  sessionId: string,
  groupId: string | null,
  itemId: string,
  claimed: boolean,
): Promise<{ session: TableSessionDto | null; error: string | null }> {
  const error = await setClaim(sessionId, groupId, itemId, claimed);
  const table = await loadTable(sessionId, groupId);
  return { session: table.status === "ok" ? table.session : null, error };
}

export async function joinTable(form: FormData) {
  const sessionId = String(form.get("sessionId") ?? "");
  const groupId = String(form.get("groupId") ?? "");
  if (!isUuid(sessionId)) redirect("/");

  const back = `/t/${sessionId}${isUuid(groupId) ? `?g=${groupId}` : ""}`;
  const error = await joinAsGuest(sessionId, String(form.get("displayName") ?? "").trim());
  redirect(error ? `${back}${back.includes("?") ? "&" : "?"}error=${encodeURIComponent(error)}` : back);
}
