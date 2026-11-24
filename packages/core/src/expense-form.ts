import type { ExpenseDto, ExpenseWriteDto } from "@kitty/api-client";
import { exponent, parseMoney, parseRate, toDecimalString, type SplitMethod } from "@kitty/money";

export const CATEGORIES = [
  "food",
  "groceries",
  "transport",
  "accommodation",
  "utilities",
  "rent",
  "entertainment",
  "shopping",
  "other",
] as const;

export type ParticipantInput = { memberId: string; included: boolean; value: string };

/** What the expense form holds while someone types: strings, exactly as entered. */
export type ExpenseFormState = {
  id: string;
  version: number | null;
  description: string;
  category: string;
  currency: string;
  amount: string;
  occurredOn: string;
  payerId: string;
  method: SplitMethod;
  participants: ParticipantInput[];
  /** A rate the person typed, or "" to let the ledger use the ECB rate (or keep the saved one). Clear it when the currency or date changes. */
  fxRate: string;
};

/** "33.33" → 3333 basis points; at most two decimals, 0 < p ≤ 100. */
export function parsePercentToBasisPoints(input: string): number | null {
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bp > 0 && bp <= 10_000 ? bp : null;
}

function parseValue(method: SplitMethod, input: string, currency: string): number | null {
  switch (method) {
    case "equal":
      return null;
    case "exact":
      return parseMoney(input, currency);
    case "percent":
      return parsePercentToBasisPoints(input);
    case "shares":
      return /^\d{1,4}$/.test(input.trim()) ? Number(input.trim()) : null;
  }
}

const VALUE_ERRORS: Record<SplitMethod, string> = {
  equal: "",
  exact: "Each person needs a valid amount.",
  percent: "Each person needs a valid percentage.",
  shares: "Each person needs a valid share.",
};

/** Converts the form into the ledger's request body, or a message to show next to the form. */
export function toExpenseWriteDto(form: ExpenseFormState): ExpenseWriteDto | { error: string } {
  const amountMinor = parseMoney(form.amount, form.currency);
  if (amountMinor === null || amountMinor <= 0) return { error: "Enter a valid amount." };

  const included = form.participants.filter((p) => p.included);
  if (included.length === 0) return { error: "Pick at least one person to split with." };

  const participants: ExpenseWriteDto["split"]["participants"] = [];
  for (const p of included) {
    const value = parseValue(form.method, p.value, form.currency);
    if (form.method !== "equal" && (value === null || value <= 0)) return { error: VALUE_ERRORS[form.method] };
    participants.push({ memberId: p.memberId, value });
  }

  let fxRate: string | undefined;
  if (form.fxRate.trim() !== "") {
    const rate = parseRate(form.fxRate.trim());
    if (rate === null) return { error: "That exchange rate doesn't look right." };
    fxRate = rate;
  }

  return {
    id: form.id,
    description: form.description.trim(),
    category: form.category,
    currency: form.currency,
    amountMinor,
    occurredOn: form.occurredOn,
    payers: [{ memberId: form.payerId, amountMinor }],
    split: { method: form.method, participants },
    version: form.version,
    ...(fxRate === undefined ? {} : { fxRate }),
  };
}

/** A blank form: everyone in, split equally, in the group's currency, paid by the person adding it. */
export function newExpenseForm(o: { id: string; today: string; currency: string; meId: string; memberIds: readonly string[] }): ExpenseFormState {
  return {
    id: o.id,
    version: null,
    description: "",
    category: "other",
    currency: o.currency,
    amount: "",
    occurredOn: o.today,
    payerId: o.meId,
    method: "equal",
    participants: o.memberIds.map((memberId) => ({ memberId, included: true, value: "" })),
    fxRate: "",
  };
}

type EditableExpense = Pick<ExpenseDto, "id" | "version" | "description" | "category" | "currency" | "amountMinor" | "occurredOn" | "payers"> & {
  split: { method: SplitMethod | "itemized"; participants: { memberId: string; value?: number | null }[] };
};

/**
 * A saved expense as the form shows it: amounts and percentages back as decimal text. An itemized one (split at
 * the table) can't be edited this way; callers show it read-only before getting here.
 */
export function editExpenseForm(expense: EditableExpense, memberIds: readonly string[], meId: string): ExpenseFormState {
  const method = expense.split.method;
  if (method === "itemized") throw new Error("An itemized expense can't be edited in the expense form.");
  const exp = exponent(expense.currency);
  const valueText = (memberId: string): string => {
    const p = expense.split.participants.find((x) => x.memberId === memberId);
    if (!p || p.value === null || p.value === undefined) return "";
    if (expense.split.method === "exact") return toDecimalString(p.value, exp);
    if (expense.split.method === "percent") return toDecimalString(p.value, 2);
    return String(p.value);
  };
  return {
    id: expense.id,
    version: expense.version,
    description: expense.description,
    category: expense.category,
    currency: expense.currency,
    amount: toDecimalString(expense.amountMinor, exp),
    occurredOn: expense.occurredOn,
    payerId: expense.payers[0]?.memberId ?? meId,
    method,
    participants: memberIds.map((memberId) => ({
      memberId,
      included: expense.split.participants.some((p) => p.memberId === memberId),
      value: valueText(memberId),
    })),
    fxRate: "",
  };
}

/** The split preview's error codes, in words. */
export function splitProblemMessage(code: string): string {
  switch (code) {
    case "split_sum_mismatch":
      return "The split must add up to the total.";
    case "split_invalid_value":
      return "Each person needs a positive number.";
    default:
      return "Check the split.";
  }
}
