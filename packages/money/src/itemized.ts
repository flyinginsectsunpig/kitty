import { compareMemberIds, MAX_TOTAL_MINOR, type SplitError, type SplitShare } from "./split";

export type ItemizedItem = { itemId: string; lineTotalMinor: number; claimerIds: string[] };

/**
 * Live preview of the ledger's itemized split (C# ItemizedSplitCalculator; both run
 * contracts/fixtures/itemized.json). Items split among claimers (unclaimed: everyone); charges follow
 * item subtotals (equally if all are zero); floors + leftover units in member order. Only people who
 * owe something are returned, in member order.
 */
export function previewItemized(items: ItemizedItem[], chargesMinor: number, participants: string[]): SplitShare[] | SplitError {
  if (participants.length === 0) return { error: "split_empty" };
  const everyone = [...participants].sort(compareMemberIds);
  if (new Set(everyone.map((p) => p.toLowerCase())).size !== everyone.length) return { error: "split_duplicate_member" };

  const known = new Set(everyone);
  const valid = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= MAX_TOTAL_MINOR;
  if (!valid(chargesMinor) || items.some((i) => !valid(i.lineTotalMinor) || i.claimerIds.some((c) => !known.has(c))))
    return { error: "split_invalid_value" };

  const total = items.reduce((a, i) => a + i.lineTotalMinor, 0) + chargesMinor;
  if (total <= 0 || total > MAX_TOTAL_MINOR) return { error: "split_invalid_value" };

  const subtotals = new Map(everyone.map((id) => [id, 0]));
  const add = (id: string, minor: number) => subtotals.set(id, subtotals.get(id)! + minor);

  for (const item of items) {
    const claimers = item.claimerIds.length === 0 ? everyone : [...new Set(item.claimerIds)].sort(compareMemberIds);
    for (const [id, minor] of distribute(item.lineTotalMinor, claimers, () => 1)) add(id, minor);
  }

  const itemsTotal = [...subtotals.values()].reduce((a, b) => a + b, 0);
  const charged =
    itemsTotal === 0
      ? distribute(chargesMinor, everyone, () => 1)
      : distribute(chargesMinor, everyone.filter((id) => subtotals.get(id)! > 0), (id) => subtotals.get(id)!);
  for (const [id, minor] of charged) add(id, minor);

  return everyone.filter((id) => subtotals.get(id)! > 0).map((id) => ({ memberId: id, minor: subtotals.get(id)! }));
}

function distribute(amount: number, ordered: string[], weight: (id: string) => number): [string, number][] {
  if (amount === 0 || ordered.length === 0) return [];
  const weightSum = BigInt(ordered.reduce((a, id) => a + weight(id), 0));
  const shares = ordered.map((id) => Number((BigInt(amount) * BigInt(weight(id))) / weightSum));
  let leftover = amount - shares.reduce((a, b) => a + b, 0);
  for (let i = 0; leftover > 0; i = (i + 1) % shares.length, leftover--) shares[i] = shares[i]! + 1;
  return ordered.map((id, i) => [id, shares[i]!]);
}
