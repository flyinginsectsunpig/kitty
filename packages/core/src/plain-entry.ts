import { exponent, formatMoney, previewSplit, toDecimalString } from "@kitty/money";
import type { Schemas } from "@kitty/api-client";
import type { ExpenseFormState } from "./expense-form";

/** Something the person has to settle on the card before Save: a name that matched nobody or several people, a
 * missing amount or group, or a total that doesn't match the amounts. */
export type DraftIssue = {
  field: string; // "group", "payer", "amount", "people[1]", "people[1].amount", "reminder.member"
  kind: "no_match" | "ambiguous" | "missing" | "mismatch" | "other_currency";
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

/** An expense the other person still owes on, as the payment card lists it. */
export type OpenItem = { expenseId: string; description: string; date: string; openMinor: number };

export type PaymentCover = { expenseId: string; amountMinor: number };

/** A payment that crosses off expenses. amountMinor is null while the sentence's amount couldn't be read. */
export type PaymentDraft = {
  fromMemberId: string | null;
  toMemberId: string | null;
  currency: string;
  amountMinor: number | null;
  statedAmountMinor: number | null;
  openItems: OpenItem[]; // oldest first
  covers: PaymentCover[];
  /** The items ticked on the card, kept apart from the covers: one the amount doesn't reach stays ticked. The ai
   * draft has none; until the first tick it's the covers' items (see tickedOf). */
  ticked?: string[];
};

/** What the ai service's /parse and /resolve return: one sentence, read and matched to a group. Nothing is saved. */
export type PlainDraft = {
  intent: "expense" | "reminder" | "payment" | "question" | "unclear";
  groupId: string | null;
  expense?: ExpenseDraft;
  reminder?: ReminderDraft;
  payment?: PaymentDraft;
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

/**
 * Spreads a payment over the ticked items, oldest first (by date, then id). With no amount each gets its open
 * amount and the amount is their sum; with one, each gets up to its open amount until it runs out, and the amount
 * stays as given.
 */
export function allocateCovers(
  items: OpenItem[],
  ticked: string[],
  amountMinor: number | null,
): { covers: PaymentCover[]; amountMinor: number } {
  const chosen = oldestFirst(items.filter((i) => ticked.includes(i.expenseId)));
  let left = amountMinor;
  const covers: PaymentCover[] = [];
  for (const item of chosen) {
    const take = left === null ? item.openMinor : Math.min(item.openMinor, left);
    if (take <= 0) break;
    covers.push({ expenseId: item.expenseId, amountMinor: take });
    if (left !== null) left -= take;
  }
  return { covers, amountMinor: amountMinor ?? covers.reduce((sum, c) => sum + c.amountMinor, 0) };
}

function oldestFirst(items: OpenItem[]): OpenItem[] {
  return [...items].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.expenseId < b.expenseId ? -1 : a.expenseId > b.expenseId ? 1 : 0,
  );
}

/** What one ticked item gets from the payment: all of what's open, part of it, or nothing (the payment ran out). */
export type CoverLine = {
  expenseId: string;
  description: string;
  openMinor: number;
  coveredMinor: number;
  state: "full" | "part" | "none";
};

/** The ticked items, oldest first, each with what the covers give it. Both the card and Settle up say this before Save. */
export function coverLines(items: OpenItem[], ticked: string[], covers: PaymentCover[]): CoverLine[] {
  const given = new Map(covers.map((c) => [c.expenseId, c.amountMinor]));
  return oldestFirst(items.filter((i) => ticked.includes(i.expenseId))).map((i) => {
    const coveredMinor = given.get(i.expenseId) ?? 0;
    const state = coveredMinor >= i.openMinor ? "full" : coveredMinor > 0 ? "part" : "none";
    return { expenseId: i.expenseId, description: i.description, openMinor: i.openMinor, coveredMinor, state };
  });
}

/** The note under a ticked item the payment doesn't fully cover; null when it covers it all. */
export function coverNote(line: CoverLine, currency: string): string | null {
  if (line.state === "part") {
    return `${line.description}: ${draftMoney(line.coveredMinor, currency)} of ${draftMoney(line.openMinor, currency)}`;
  }
  if (line.state === "none") return `${line.description}: not covered, the payment runs out`;
  return null;
}

/** The items ticked on a payment card: as ticked, or the ai draft's covers before the first tick. */
export function tickedOf(p: PaymentDraft): string[] {
  return p.ticked ?? p.covers.map((c) => c.expenseId);
}

function withTicked(draft: PlainDraft, ticked: string[]): PlainDraft {
  const p = draft.payment;
  if (!p) return draft;
  const { covers, amountMinor } = allocateCovers(p.openItems, ticked, p.statedAmountMinor);
  return { ...draft, payment: { ...p, ticked, covers, amountMinor } };
}

/** Ticks or unticks one open item, then spreads the amount again. */
export function toggleCover(draft: PlainDraft, expenseId: string): PlainDraft {
  const p = draft.payment;
  if (!p) return draft;
  const ticked = tickedOf(p);
  return withTicked(draft, ticked.includes(expenseId) ? ticked.filter((id) => id !== expenseId) : [...ticked, expenseId]);
}

/** A copy of the model's reading with the counterpart replaced, to send back to /resolve. */
export function withCounterpart(parsed: unknown, displayName: string): unknown {
  return { ...(parsed as Record<string, unknown>), counterpart: displayName };
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
  if (draft.payment && /^payment\.items\[\d+\]$/.test(issue.field)) {
    const base = { ...draft, issues };
    if (!memberId) return base;
    const ticked = tickedOf(draft.payment);
    return withTicked(base, ticked.includes(memberId) ? ticked : [...ticked, memberId]);
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
  if (draft.intent === "payment") {
    const p = draft.payment;
    if (!p || !p.fromMemberId || !p.toMemberId || p.amountMinor === null || p.amountMinor <= 0) return false;
    const covered = p.covers.reduce((sum, c) => sum + c.amountMinor, 0);
    return p.covers.length > 0 && covered <= p.amountMinor;
  }
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

/** The settlement the payment card saves. Sentences only cross off group-currency items, so no rate is sent. */
export function toSettlementWriteDto(draft: PlainDraft, id: string): Schemas["SettlementWriteDto"] {
  const p = draft.payment;
  if (!p || !p.fromMemberId || !p.toMemberId || p.amountMinor === null) {
    throw new Error("Only a finished payment draft makes a settlement.");
  }
  return {
    id,
    fromMemberId: p.fromMemberId,
    toMemberId: p.toMemberId,
    currency: p.currency,
    amountMinor: p.amountMinor,
    paidInGroupCurrency: false,
    covers: p.covers.map((c) => ({ expenseId: c.expenseId, amountMinor: c.amountMinor })),
  };
}

/**
 * The line under a payment when both people have open items in its currency: the net of the two sides, so
 * crossing one off isn't mistaken for the whole story. null unless both sides are open.
 */
export function countingBoth(open: Schemas["OpenItemsDto"], currency: string, meMemberId: string, otherName: string): string | null {
  const c = open.currencies.find((x) => x.currency === currency);
  if (!c || c.fromOwesTotal.minor <= 0 || c.toOwesTotal.minor <= 0) return null;
  const meIsFrom = open.fromMemberId === meMemberId;
  const iOwe = meIsFrom ? c.fromOwesTotal.minor : c.toOwesTotal.minor;
  const theyOwe = meIsFrom ? c.toOwesTotal.minor : c.fromOwesTotal.minor;
  const lead = `Counting what ${otherName} owes you,`;
  if (theyOwe === iOwe) return `${lead} you're even.`;
  if (theyOwe > iOwe) return `${lead} ${otherName} owes you ${draftMoney(theyOwe - iOwe, currency)}.`;
  return `${lead} you still owe ${otherName} ${draftMoney(iOwe - theyOwe, currency)}.`;
}
