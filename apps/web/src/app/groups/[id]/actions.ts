"use server";

import type { ExpenseWriteDto } from "@kitty/api-client";
import { redirect } from "next/navigation";
import { getLedger, problemCode } from "@/lib/ledger";

function field(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing form field '${name}'.`);
  return value;
}

/** Each form renders its own Idempotency-Key, so a double-submit replays instead of duplicating. */
function keyed(form: FormData) {
  return { headers: { "Idempotency-Key": field(form, "idempotencyKey") } };
}

function withError(path: string, error: unknown): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${problemCode(error)}`);
}

export async function saveExpense(form: FormData) {
  const groupId = field(form, "groupId");
  const body = JSON.parse(field(form, "payload")) as ExpenseWriteDto;
  const ledger = await getLedger();
  const path = { params: { path: { groupId } }, body, ...keyed(form) };

  if (body.version === null) {
    const { error } = await ledger.POST("/groups/{groupId}/expenses", path);
    if (error) withError(`/groups/${groupId}/expenses/new`, error);
  } else {
    const { error } = await ledger.PUT("/groups/{groupId}/expenses/{expenseId}", {
      ...path,
      params: { path: { groupId, expenseId: body.id } },
    });
    if (error) withError(`/groups/${groupId}/expenses/${body.id}/edit`, error);
  }
  redirect(`/groups/${groupId}`);
}

export async function deleteExpense(form: FormData) {
  const groupId = field(form, "groupId");
  const expenseId = field(form, "expenseId");
  const ledger = await getLedger();
  const { error } = await ledger.DELETE("/groups/{groupId}/expenses/{expenseId}", {
    params: { path: { groupId, expenseId } },
    ...keyed(form),
  });
  if (error) withError(`/groups/${groupId}/expenses/${expenseId}/edit`, error);
  redirect(`/groups/${groupId}`);
}

export async function addPlaceholder(form: FormData) {
  const groupId = field(form, "groupId");
  const ledger = await getLedger();
  const { error } = await ledger.POST("/groups/{groupId}/members", {
    params: { path: { groupId } },
    body: { displayName: String(form.get("displayName") ?? "") },
    ...keyed(form),
  });
  if (error) withError(`/groups/${groupId}/members`, error);
  redirect(`/groups/${groupId}/members`);
}

export async function createInvite(form: FormData) {
  const groupId = field(form, "groupId");
  const memberId = form.get("memberId");
  const ledger = await getLedger();
  const { data, error } = await ledger.POST("/groups/{groupId}/invites", {
    params: { path: { groupId } },
    body: { memberId: typeof memberId === "string" && memberId ? memberId : null },
    ...keyed(form),
  });
  if (error || !data) withError(`/groups/${groupId}/members`, error);
  redirect(`/groups/${groupId}/members?invite=${encodeURIComponent(data.token)}`);
}

export async function updateMyDetails(form: FormData) {
  const groupId = field(form, "groupId");
  const memberId = field(form, "memberId");
  const ledger = await getLedger();
  const { error } = await ledger.PATCH("/groups/{groupId}/members/{memberId}", {
    params: { path: { groupId, memberId } },
    body: {
      displayName: String(form.get("displayName") ?? ""),
      paymentDetails: String(form.get("paymentDetails") ?? ""),
    },
    ...keyed(form),
  });
  if (error) withError(`/groups/${groupId}/members`, error);
  redirect(`/groups/${groupId}/members?saved=1`);
}

export async function recordSettlement(form: FormData) {
  const groupId = field(form, "groupId");
  const ledger = await getLedger();
  const { error } = await ledger.POST("/groups/{groupId}/settlements", {
    params: { path: { groupId } },
    body: {
      id: field(form, "settlementId"),
      fromMemberId: field(form, "fromMemberId"),
      toMemberId: field(form, "toMemberId"),
      currency: field(form, "currency"),
      amountMinor: Number(field(form, "amountMinor")),
    },
    ...keyed(form),
  });
  if (error) withError(`/groups/${groupId}/settle`, error);
  redirect(`/groups/${groupId}/settle?settled=1`);
}
