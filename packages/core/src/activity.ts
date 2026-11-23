import { formatMoney, isSupported } from "@kitty/money";

/** The parts of an audit snapshot the activity feed shows. */
export type ActivitySnapshot = { description?: string; displayName?: string; name?: string; amountMinor?: number; currency?: string } | null;

/** What an activity entry was about, in words: `expense "Petrol" (R 600,00)`, `a payment (R 5,00)`, `Sam`. */
export function describeActivity(entityType: string, snapshot: ActivitySnapshot): string {
  if (!snapshot) return entityType;
  const amount =
    typeof snapshot.amountMinor === "number" && snapshot.currency && isSupported(snapshot.currency)
      ? ` (${formatMoney(snapshot.amountMinor, snapshot.currency)})`
      : "";
  switch (entityType) {
    case "expense":
      return `expense "${snapshot.description ?? ""}"${amount}`;
    case "settlement":
      return `a payment${amount}`;
    case "member":
      return `${snapshot.displayName ?? "a person"}`;
    case "group":
      return `the group${snapshot.name ? ` "${snapshot.name}"` : ""}`;
    default:
      return entityType;
  }
}
