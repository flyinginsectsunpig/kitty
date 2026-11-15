import { exponent } from "./currencies";

/**
 * Parses what a person typed ("12,50", "1 234.56", "600") into integer minor units, or null if it is
 * not a valid non-negative amount for the currency. Pure string handling: no floating point.
 * The last '.' or ',' is the decimal separator when followed by at most `exponent` digits;
 * other separators and spaces are thousands separators. A lone separator followed by more digits
 * than the currency allows ("1.234" for ZAR) is ambiguous and rejected.
 */
export function parseMoney(input: string, currency: string): number | null {
  const exp = exponent(currency);
  const s = input.replace(/[\s  ]/g, "");
  if (!/^\d[\d.,]*$/.test(s)) return null;

  const lastSep = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  let whole = s;
  let fraction = "";
  if (lastSep >= 0) {
    const tail = s.slice(lastSep + 1);
    const isDecimal = tail.length > 0 && tail.length <= exp;
    const separatorCount = (s.match(/[.,]/g) ?? []).length;
    const isThousands = tail.length === 3 && separatorCount > 1;
    if (isDecimal) {
      whole = s.slice(0, lastSep);
      fraction = tail;
    } else if (!isThousands) {
      return null;
    }
  }

  // Remaining separators must be well-formed thousands groups: 1–3 digits, then groups of exactly 3.
  const groups = whole.split(/[.,]/);
  if (groups.length > 1 && !groups.every((g, i) => (i === 0 ? g.length >= 1 && g.length <= 3 : g.length === 3))) return null;

  const minor = Number(groups.join("") + fraction.padEnd(exp, "0"));
  return Number.isSafeInteger(minor) ? minor : null;
}
