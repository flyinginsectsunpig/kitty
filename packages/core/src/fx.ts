import { formatMoney } from "@kitty/money";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-20" → "20 Nov 2026" (no Intl: the same text on every device). */
function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** "1 EUR = 19.1987 ZAR · ECB, 20 Nov 2026", or "… · entered by hand" for a typed rate. */
export function describeRate(o: { from: string; to: string; rate: string; rateDate: string | null; source: string }): string {
  const where = o.source === "ecb" && o.rateDate ? `ECB, ${shortDate(o.rateDate)}` : "entered by hand";
  return `1 ${o.from} = ${o.rate} ${o.to} · ${where}`;
}

/** An expense's amount for a list: "€40,00 · R767,95" when foreign, "· no rate yet" when it has none. */
export function expenseAmounts(
  e: { currency: string; amountMinor: number; convertedAmountMinor?: number | null },
  groupCurrency: string,
): string {
  const own = formatMoney(e.amountMinor, e.currency);
  if (e.currency === groupCurrency) return own;
  return e.convertedAmountMinor == null ? `${own} · no rate yet` : `${own} · ${formatMoney(e.convertedAmountMinor, groupCurrency)}`;
}
