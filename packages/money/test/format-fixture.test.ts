import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { formatMoney } from "../src/index";

type Case = { minor: number; currency: string; expected: string };

// The ledger's MoneyText runs the same file, so notifications show money exactly as the apps do.
const cases: Case[] = JSON.parse(readFileSync(new URL("../../../contracts/fixtures/money-format.json", import.meta.url), "utf8"));

test.each(cases.map((c) => [`${c.currency} ${c.minor}`, c] as const))("formatMoney %s", (_, c) => {
  expect(formatMoney(c.minor, c.currency)).toBe(c.expected);
});
