import type { ExpenseWriteDto } from "@kitty/api-client";
import { parseMoney, type SplitMethod } from "@kitty/money";

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
  };
}
