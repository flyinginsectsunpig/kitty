import { describe, expect, test } from "vitest";
import { safeNext } from "@/lib/redirects";

describe("safeNext", () => {
  test("keeps same-site paths", () => expect(safeNext("/invite/abc")).toBe("/invite/abc"));
  test("falls back when missing", () => expect(safeNext(undefined)).toBe("/groups"));
  test("keeps query and hash", () => expect(safeNext("/groups?x=1#top")).toBe("/groups?x=1#top"));
  test.each([
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "javascript:alert(1)",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\\/evil.example",
  ])(
    "rejects off-site target %s",
    (next) => expect(safeNext(next)).toBe("/groups"),
  );
});
