import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { convertMinor, parseRate } from "../src/index";

type Fixture = {
  rates: { input: string; canonical: string | null }[];
  conversions: { name: string; minor: number; rate: string; from: string; to: string; expected: number }[];
};

const fixture: Fixture = JSON.parse(readFileSync(new URL("../../../contracts/fixtures/fx.json", import.meta.url), "utf8"));

describe("parseRate matches the ledger's shared fixtures", () => {
  test.each(fixture.rates.map((r) => [JSON.stringify(r.input), r] as const))("%s", (_, r) => {
    expect(parseRate(r.input)).toBe(r.canonical);
  });
});

describe("convertMinor matches the ledger's shared fixtures", () => {
  test.each(fixture.conversions.map((c) => [c.name, c] as const))("%s", (_, c) => {
    expect(convertMinor(c.minor, c.rate, c.from, c.to)).toBe(c.expected);
  });
});
