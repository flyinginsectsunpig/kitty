"use server";

import type { Schemas } from "@kitty/api-client";
import {
  canSave,
  countingBoth,
  draftToForm,
  toExpenseWriteDto,
  toSettlementWriteDto,
  type AskResult,
  type PlainDraft,
} from "@kitty/core";
import { askKitty, finishDraft, parseSentence, resolveDraft, type AiResult } from "@/lib/ai";
import { getLedger, problemCode } from "@/lib/ledger";

export async function readSentence(text: string, groupId?: string): Promise<AiResult> {
  return parseSentence(text, groupId);
}

export async function askQuestion(
  messages: { role: "person" | "kitty"; text: string }[],
  groupId?: string,
): Promise<AskResult> {
  return askKitty(messages, groupId);
}

/** An assistant's draft was saved or sent: its link stops working. */
export async function finishDraftAction(id: string): Promise<void> {
  await finishDraft(id);
}

export async function rematchGroup(parsed: unknown, groupId: string): Promise<AiResult> {
  return resolveDraft(parsed, groupId);
}

/** Saves a confirmed draft through the ledger's normal expense endpoint. Returns an error code, or null when saved. */
export async function saveDraft(draft: PlainDraft, idempotencyKey: string): Promise<string | null> {
  if (!canSave(draft) || !draft.groupId) return "validation_failed";
  // The expense id is the request's key: a retry with the same key sends the same body, so the ledger replays it.
  const body = toExpenseWriteDto(draftToForm(draft, { id: idempotencyKey }));
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

/** What's open item by item between two members of a group, both ways; null when the ledger can't say. */
export async function openItems(groupId: string, from: string, to: string): Promise<Schemas["OpenItemsDto"] | null> {
  const ledger = await getLedger();
  const { data } = await ledger.GET("/groups/{groupId}/open-items", { params: { path: { groupId }, query: { from, to } } });
  return data ?? null;
}

/**
 * Saves a confirmed payment card as a settlement with its covers. The key is both the settlement id and the
 * Idempotency-Key, so a retry replays. Once saved, countingBoth is the line comparing what's still open both ways
 * (null when only one side is open, or it can't be worked out: the payment is saved either way).
 */
export async function savePayment(
  draft: PlainDraft,
  idempotencyKey: string,
): Promise<{ error: string | null; countingBoth: string | null }> {
  const p = draft.payment;
  if (draft.intent !== "payment" || !p || !draft.groupId || !canSave(draft)) return { error: "validation_failed", countingBoth: null };
  const groupId = draft.groupId;
  const ledger = await getLedger();
  const { error } = await ledger.POST("/groups/{groupId}/settlements", {
    params: { path: { groupId } },
    body: toSettlementWriteDto(draft, idempotencyKey),
    headers: { "Idempotency-Key": idempotencyKey },
  });
  if (error) return { error: problemCode(error), countingBoth: null };

  try {
    return { error: null, countingBoth: await countingBothAfter(groupId, p.fromMemberId!, p.toMemberId!, p.currency) };
  } catch {
    return { error: null, countingBoth: null }; // saved; only the extra line is missing
  }
}

async function countingBothAfter(groupId: string, from: string, to: string, currency: string): Promise<string | null> {
  const ledger = await getLedger();
  const [open, me, group] = await Promise.all([
    openItems(groupId, from, to),
    ledger.GET("/me").then((r) => r.data),
    ledger.GET("/groups/{groupId}", { params: { path: { groupId } } }).then((r) => r.data),
  ]);
  const meMember = group?.members.find((m) => m.userId === me?.id);
  const other = group?.members.find((m) => m.id === (meMember?.id === from ? to : from));
  if (!open || !meMember || !other) return null;
  return countingBoth(open, currency, meMember.id, other.displayName);
}
