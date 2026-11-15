"use server";

import { redirect } from "next/navigation";
import { getLedger, problemCode } from "@/lib/ledger";

async function required(form: FormData, name: string): Promise<string> {
  const value = form.get(name);
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing form field '${name}'.`);
  return value;
}

/** Each form renders its own Idempotency-Key, so a double-submit replays instead of duplicating. */
async function keyed(form: FormData) {
  return { headers: { "Idempotency-Key": await required(form, "idempotencyKey") } };
}

export async function createGroup(form: FormData) {
  const ledger = await getLedger();
  const id = await required(form, "groupId");
  const { error } = await ledger.POST("/groups", {
    body: { id, name: String(form.get("name") ?? ""), baseCurrency: await required(form, "baseCurrency") },
    ...(await keyed(form)),
  });
  if (error) redirect(`/groups/new?error=${problemCode(error)}`);
  redirect(`/groups/${id}`);
}

export async function acceptInvite(form: FormData) {
  const ledger = await getLedger();
  const token = await required(form, "token");
  const { data, error } = await ledger.POST("/invites/{token}/accept", {
    params: { path: { token } },
    ...(await keyed(form)),
  });
  if (error || !data) redirect(`/invite/${encodeURIComponent(token)}?error=${problemCode(error)}`);
  redirect(`/groups/${data.id}`);
}
