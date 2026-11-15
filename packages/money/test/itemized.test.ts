import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { previewItemized } from "../src/index";

type Fixture = {
  name: string;
  chargesMinor: number;
  participants: string[];
  items: { itemId: string; lineTotalMinor: number; claimerIds: string[] }[];
  expected: { memberId: string; minor: number }[] | null;
  error: string | null;
};

const fixtures: Fixture[] = JSON.parse(
  readFileSync(new URL("../../../contracts/fixtures/itemized.json", import.meta.url), "utf8"),
);

describe("previewItemized matches the ledger's shared fixtures", () => {
  test.each(fixtures.map((f) => [f.name, f] as const))("%s", (_, f) => {
    const result = previewItemized(f.items, f.chargesMinor, f.participants);
    if (f.error) expect(result).toEqual({ error: f.error });
    else expect(result).toEqual(f.expected);
  });
});
