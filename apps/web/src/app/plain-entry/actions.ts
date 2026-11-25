"use server";

import { canSave, draftToForm, toExpenseWriteDto, type PlainDraft } from "@kitty/core";
import { parseSentence, resolveDraft, type AiResult } from "@/lib/ai";
import { getLedger, problemCode } from "@/lib/ledger";

export async function readSentence(text: string, groupId?: string): Promise<AiResult> {
  return parseSentence(text, groupId);
}

export async function rematchGroup(parsed: unknown, groupId: string): Promise<AiResult> {
  return resolveDraft(parsed, groupId);
}

/** Saves a confirmed draft through the ledger's normal expense endpoint. Returns an error code, or null when saved. */
export async function saveDraft(draft: PlainDraft, idempotencyKey: string): Promise<string | null> {
  if (!canSave(draft) || !draft.groupId) return "validation_failed";
  const body = toExpenseWriteDto(draftToForm(draft, { id: crypto.randomUUID() }));
  if ("error" in body) return "validation_failed";
  const ledger = await getLedger();
  const { error } = await ledger.POST("/groups/{groupId}/expenses", {
    params: { path: { groupId: draft.groupId } },
    body,
    headers: { "Idempotency-Key": idempotencyKey },
  });
  return error ? problemCode(error) : null;
}

/** Reminds a member what they owe the signed-in person. Returns an error code, or null when sent. */
export async function sendReminder(groupId: string, memberId: string, idempotencyKey: string): Promise<string | null> {
  const ledger = await getLedger();
  const { error } = await ledger.POST("/groups/{groupId}/reminders", {
    params: { path: { groupId } },
    body: { memberId },
    headers: { "Idempotency-Key": idempotencyKey },
  });
  return error ? problemCode(error) : null;
}
