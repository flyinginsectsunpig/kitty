export type SplitMethod = "equal" | "exact" | "percent" | "shares";

export type SplitParticipant = { memberId: string; value: number | null };
export type SplitShare = { memberId: string; minor: number };
export type SplitError = { error: string };

export const MAX_TOTAL_MINOR = 10_000_000_000;
const FULL_PERCENT_BP = 10_000;
const MAX_SHARE_WEIGHT = 1_000;

/** The ledger's member order: ordinal comparison of the lowercase UUID string. */
export function compareMemberIds(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Live preview of how the ledger will split an expense. Mirrors the C# SplitCalculator exactly
 * (both run contracts/fixtures/splits.json): floor each share, then +1 minor unit to participants
 * in member order until the total is reached. The server's result is authoritative.
 */
export function previewSplit(totalMinor: number, method: SplitMethod, participants: SplitParticipant[]): SplitShare[] | SplitError {
  if (participants.length === 0) return { error: "split_empty" };
  if (new Set(participants.map((p) => p.memberId.toLowerCase())).size !== participants.length)
    return { error: "split_duplicate_member" };
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0 || totalMinor > MAX_TOTAL_MINOR) return { error: "split_invalid_value" };

  const ordered = [...participants].sort((a, b) => compareMemberIds(a.memberId, b.memberId));

  switch (method) {
    case "equal":
      return distribute(totalMinor, ordered, () => Math.floor(totalMinor / ordered.length));
    case "exact": {
      if (ordered.some((p) => !isPositiveInt(p.value) || p.value! > totalMinor)) return { error: "split_invalid_value" };
      if (sum(ordered.map((p) => p.value!)) !== totalMinor) return { error: "split_sum_mismatch" };
      return ordered.map((p) => ({ memberId: p.memberId, minor: p.value! }));
    }
    case "percent":
      return weighted(totalMinor, ordered, FULL_PERCENT_BP, FULL_PERCENT_BP);
    case "shares":
      return weighted(totalMinor, ordered, MAX_SHARE_WEIGHT, null);
  }
}

function weighted(totalMinor: number, ordered: SplitParticipant[], maxValue: number, mustSumTo: number | null): SplitShare[] | SplitError {
  if (ordered.some((p) => !isPositiveInt(p.value) || p.value! > maxValue)) return { error: "split_invalid_value" };
  const weightSum = sum(ordered.map((p) => p.value!));
  if (mustSumTo !== null && weightSum !== mustSumTo) return { error: "split_sum_mismatch" };
  // BigInt keeps total × weight exact beyond 2^53.
  return distribute(totalMinor, ordered, (p) => Number((BigInt(totalMinor) * BigInt(p.value!)) / BigInt(weightSum)));
}

function distribute(totalMinor: number, ordered: SplitParticipant[], base: (p: SplitParticipant) => number): SplitShare[] {
  const amounts = ordered.map(base);
  let leftover = totalMinor - sum(amounts);
  for (let i = 0; leftover > 0; i = (i + 1) % amounts.length, leftover--) amounts[i] = amounts[i]! + 1;
  return ordered.map((p, i) => ({ memberId: p.memberId, minor: amounts[i]! }));
}

function isPositiveInt(v: number | null): boolean {
  return v !== null && Number.isSafeInteger(v) && v > 0;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
