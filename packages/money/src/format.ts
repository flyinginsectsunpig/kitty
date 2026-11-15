import { exponent } from "./currencies";

/** "-1234.56" for (-123456, 2) — exact string arithmetic, no floating point. */
export function toDecimalString(minor: number, exp: number): string {
  if (!Number.isSafeInteger(minor)) throw new Error("Amount must be a safe integer of minor units.");
  const sign = minor < 0 ? "-" : "";
  const digits = Math.abs(minor).toString().padStart(exp + 1, "0");
  return exp === 0 ? sign + digits : `${sign}${digits.slice(0, -exp)}.${digits.slice(-exp)}`;
}

/** Formats integer minor units as currency for display, e.g. formatMoney(123456, "ZAR") → "R 1 234,56". */
export function formatMoney(minor: number, currency: string, locale = "en-ZA"): string {
  const exp = exponent(currency);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  }).format(toDecimalString(minor, exp) as Intl.StringNumericLiteral);
}
