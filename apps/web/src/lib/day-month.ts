const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-18" → "18 Nov" (no Intl: the same text on the server and in the browser). Anything else shows as given. */
export function dayMonth(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso);
  const month = m ? MONTHS[Number(m[1]) - 1] : undefined;
  return m && month ? `${Number(m[2])} ${month}` : iso;
}
