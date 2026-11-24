import { exponent } from "./currencies";

const PLACES = 10;
const SCALE = 10n ** BigInt(PLACES);
const MAX_RATE = 1_000_000n * SCALE;
const SHAPE = /^(0|[1-9]\d{0,6})(\.\d{1,10})?$/;

/** The rate as an integer count of 10^-10 units, or null when it isn't a valid rate. */
function scaled(input: string): bigint | null {
  const m = SHAPE.exec(input);
  if (!m) return null;
  const whole = BigInt(m[1]!);
  const fraction = (m[2] ?? ".").slice(1).padEnd(PLACES, "0");
  const value = whole * SCALE + BigInt(fraction);
  return value > 0n && value <= MAX_RATE ? value : null;
}

/**
 * An exchange rate as typed: a plain decimal above 0, at most 1,000,000, at most 10 decimal places. Returns the
 * canonical text with no trailing zeros ("19.1987"), or null. Same rule as the ledger's FxRate (contracts/fixtures/fx.json).
 */
export function parseRate(input: string): string | null {
  const value = scaled(input);
  if (value === null) return null;
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(PLACES, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/**
 * Preview of the ledger's conversion: minor × rate, rescaled between the currencies' minor units, rounded half away
 * from zero. Exact (BigInt), and identical to the ledger's FxConverter. The ledger's result is authoritative.
 */
export function convertMinor(minor: number, rate: string, from: string, to: string): number {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error("minor must be a non-negative safe integer.");
  const r = scaled(rate);
  if (r === null) throw new Error(`'${rate}' is not a valid rate.`);
  const shift = exponent(to) - exponent(from);
  const num = BigInt(minor) * r * 10n ** BigInt(Math.max(0, shift));
  const den = SCALE * 10n ** BigInt(Math.max(0, -shift));
  const quotient = num / den + ((num % den) * 2n >= den ? 1n : 0n);
  return Number(quotient);
}
