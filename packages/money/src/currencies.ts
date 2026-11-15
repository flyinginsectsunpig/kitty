import table from "../../../contracts/currencies.json" with { type: "json" };

/** Supported ISO 4217 codes → minor-unit exponent. Same file the ledger embeds. */
const exponents: Readonly<Record<string, number>> = table;

export const supportedCurrencies: readonly string[] = Object.keys(exponents).sort();

export function isSupported(code: string): boolean {
  return Object.hasOwn(exponents, code);
}

export function exponent(code: string): number {
  const e = exponents[code];
  if (e === undefined) throw new Error(`Unsupported currency '${code}'.`);
  return e;
}
