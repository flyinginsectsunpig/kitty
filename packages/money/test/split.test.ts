import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { previewSplit, type SplitMethod } from "../src/index";

type Fixture = {
  name: string;
  totalMinor: number;
  method: SplitMethod;
  participants: { memberId: string; value: number | null }[];
  expected: { memberId: string; minor: number }[] | null;
  error: string | null;
};

const fixtures: Fixture[] = JSON.parse(
  readFileSync(new URL("../../../contracts/fixtures/splits.json", import.meta.url), "utf8"),
);

describe("previewSplit matches the ledger's shared fixtures", () => {
  test.each(fixtures.map((f) => [f.name, f] as const))("%s", (_, f) => {
    const result = previewSplit(f.totalMinor, f.method, f.participants);
    if (f.error) expect(result).toEqual({ error: f.error });
    else expect(result).toEqual(f.expected);
  });
});
