import { exponent, formatMoney, previewSplit, toDecimalString } from "@kitty/money";
import type { ExpenseFormState } from "./expense-form";

/** Something the person has to settle on the card before Save: a name that matched nobody or several people, a
 * missing amount or group, or a total that doesn't match the amounts. */
export type DraftIssue = {
  field: string; // "group", "payer", "amount", "people[1]", "people[1].amount", "reminder.member"
  kind: "no_match" | "ambiguous" | "missing" | "mismatch";
  text: string;
  candidates: string[];
};

export type DraftParticipant = { memberId: string | null; name: string; amountMinor: number | null };

export type ExpenseDraft = {
  description: string;
  category: string;
  currency: string;
  amountMinor: number | null;
  occurredOn: string;
  payerMemberId: string | null;
  split: "equal" | "amounts";
  participants: DraftParticipant[];
};

/** owedMinorByCurrency is null when the person picked someone else on the card (the ledger works it out on Send). */
export type ReminderDraft = {
  memberId: string | null;
  name: string | null;
  owedMinorByCurrency: Record<string, number> | null;
  statedAmountMinor: number | null;
  statedCurrency: string;
};

/** What the ai service's /parse and /resolve return: one sentence, read and matched to a group. Nothing is saved. */
export type PlainDraft = {
  intent: "expense" | "reminder" | "question" | "unclear";
  groupId: string | null;
  expense?: ExpenseDraft;
  reminder?: ReminderDraft;
  issues: DraftIssue[];
  members: { id: string; displayName: string }[];
  groups: { id: string; name: string }[];
  /** The model's reading, sent back to /resolve when the person picks another group. */
  parsed: unknown;
};

/** The expense form, filled in from a draft: everyone in the group listed, the people named ticked. */
export function draftToForm(draft: PlainDraft, o: { id: string }): ExpenseFormState {
  const e = draft.expense;
  if (!e) throw new Error("Only an expense draft fills the expense form.");
  const exp = exponent(e.currency);
  const named = new Map(e.participants.filter((p) => p.memberId).map((p) => [p.memberId!, p]));
  return {
    id: o.id,
    version: null,
    description: e.description,
    category: e.category,
    currency: e.currency,
    amount: e.amountMinor === null ? "" : toDecimalString(e.amountMinor, exp),
    occurredOn: e.occurredOn,
    payerId: e.payerMemberId ?? draft.members[0]?.id ?? "",
    method: e.split === "amounts" ? "exact" : "equal",
    participants: draft.members.map((m) => {
      const p = named.get(m.id);
      const value = p && e.split === "amounts" && p.amountMinor !== null ? toDecimalString(p.amountMinor, exp) : "";
      return { memberId: m.id, included: p !== undefined, value };
    }),
    fxRate: "",
  };
}

const PERSON = /^people\[(\d+)\]$/;

/**
 * Settles one issue: memberId picks that member; null leaves the person out (an equal split shares among the rest;
 * a split by amounts loses their amount from the total).
 */
export function applyPick(draft: PlainDraft, issueIndex: number, memberId: string | null): PlainDraft {
  const issue = draft.issues[issueIndex];
  if (!issue) return draft;
  const issues = draft.issues.filter((_, i) => i !== issueIndex);

  if (issue.field === "payer" && draft.expense && memberId) {
    return { ...draft, issues, expense: { ...draft.expense, payerMemberId: memberId } };
  }
  if (issue.field === "reminder.member" && draft.reminder && memberId) {
    const name = draft.members.find((m) => m.id === memberId)?.displayName ?? null;
    return { ...draft, issues, reminder: { ...draft.reminder, memberId, name, owedMinorByCurrency: null } };
  }
  const person = PERSON.exec(issue.field);
  if (!person || !draft.expense) return draft;
  const index = Number(person[1]);
  const e = draft.expense;

  if (memberId) {
    const participants = e.participants.map((p, i) => (i === index ? { ...p, memberId } : p));
    return { ...draft, issues, expense: { ...e, participants } };
  }

  // Leave them out: drop their row, renumber the issues of the people after them, re-total a split by amounts.
  const participants = e.participants.filter((_, i) => i !== index);
  const renumbered = issues
    .filter((i) => !i.field.startsWith(`people[${index}]`))
    .map((i) => {
      const m = /^people\[(\d+)\](.*)$/.exec(i.field);
      return m && Number(m[1]) > index ? { ...i, field: `people[${Number(m[1]) - 1}]${m[2]}` } : i;
    });
  const amountMinor =
    e.split === "amounts" && participants.every((p) => p.amountMinor !== null)
      ? participants.reduce((sum, p) => sum + (p.amountMinor ?? 0), 0)
      : e.amountMinor;
  return { ...draft, issues: renumbered, expense: { ...e, participants, amountMinor } };
}

/** Whether Save (or Send) can go ahead: nothing left to settle and everything the ledger needs is there. */
export function canSave(draft: PlainDraft): boolean {
  if (draft.issues.length > 0 || !draft.groupId) return false;
  if (draft.intent === "reminder") return !!draft.reminder?.memberId;
  if (draft.intent !== "expense" || !draft.expense) return false;
  const e = draft.expense;
  return (
    e.amountMinor !== null &&
    e.amountMinor > 0 &&
    !!e.payerMemberId &&
    e.participants.length > 0 &&
    e.participants.every((p) => p.memberId !== null)
  );
}

/** The ai service's HTTP status as an error code the apps have a message for (see errors.ts). */
export function aiErrorCode(status: number): string {
  switch (status) {
    case 400:
      return "sentence_invalid";
    case 401:
      return "ai_signed_out"; // no token, or one from before the kitty-ai audience existed
    case 404:
      return "not_found";
    case 422:
      return "unclear";
    case 429:
      return "ai_rate_limited";
    case 503:
      return "ai_unavailable";
    default:
      return "unexpected";
  }
}

/**
 * Each person's share as the card shows it, in participant order: an equal split shared out exactly as the ledger
 * will (so "Lee owes R150" shows R150 on Lee, and "you and Sam" R42,50 each), amounts as given. null while a person
 * or the total isn't known yet.
 */
export function draftShares(draft: PlainDraft): (number | null)[] {
  const e = draft.expense;
  if (!e) return [];
  if (e.split === "amounts") return e.participants.map((p) => p.amountMinor);
  if (e.amountMinor === null || e.participants.some((p) => p.memberId === null)) return e.participants.map(() => null);
  const shares = previewSplit(
    e.amountMinor,
    "equal",
    e.participants.map((p) => ({ memberId: p.memberId!, value: null })),
  );
  if ("error" in shares) return e.participants.map(() => null);
  const byMember = new Map(shares.map((s) => [s.memberId, s.minor]));
  return e.participants.map((p) => byMember.get(p.memberId!) ?? null);
}

/** Money on the card. A currency Kitty doesn't support (the model made one up) shows as its code, never a crash. */
export function draftMoney(minor: number, currency: string): string {
  try {
    return formatMoney(minor, currency);
  } catch {
    return `${currency} ${minor}`;
  }
}
