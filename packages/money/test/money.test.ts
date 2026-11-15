import { describe, expect, test } from "vitest";
import { exponent, formatMoney, parseMoney } from "../src/index";

describe("exponent", () => {
  test("ZAR has 2 decimals", () => expect(exponent("ZAR")).toBe(2));
  test("JPY has 0 decimals", () => expect(exponent("JPY")).toBe(0));
  test("unknown currency throws", () => expect(() => exponent("XXX")).toThrow());
});

describe("formatMoney", () => {
  test("formats ZAR like Intl en-ZA", () =>
    expect(formatMoney(123456, "ZAR")).toBe(
      new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(1234.56),
    ));
  test("JPY has no decimals", () => {
    const s = formatMoney(334, "JPY");
    expect(s).toContain("334");
    expect(s).not.toMatch(/334[.,]\d/);
  });
  test("negative amounts keep their sign", () => expect(formatMoney(-300, "ZAR")).toMatch(/-|−/));
  test("large amounts are exact (no float drift)", () =>
    expect(formatMoney(9_007_199_254_740_99, "USD", "en-US")).toBe("$9,007,199,254,740.99"));
});

describe("parseMoney", () => {
  test("parse 12.5 ZAR = 1250", () => expect(parseMoney("12.5", "ZAR")).toBe(1250));
  test("parse accepts comma decimal", () => expect(parseMoney("12,50", "ZAR")).toBe(1250));
  test("parse rejects 3 decimals for ZAR", () => expect(parseMoney("1.234", "ZAR")).toBeNull());
  test("whole numbers", () => expect(parseMoney("600", "ZAR")).toBe(60000));
  test("thousands separators and spaces", () => {
    expect(parseMoney("1 234,56", "ZAR")).toBe(123456);
    expect(parseMoney("1,234.56", "USD")).toBe(123456);
  });
  test("JPY rejects decimals", () => expect(parseMoney("10.5", "JPY")).toBeNull());
  test("garbage is rejected", () => {
    expect(parseMoney("", "ZAR")).toBeNull();
    expect(parseMoney("abc", "ZAR")).toBeNull();
    expect(parseMoney("-5", "ZAR")).toBeNull();
    expect(parseMoney("1.2.3", "ZAR")).toBeNull();
  });
});

describe("parseMoney thousands", () => {
  test("multiple groups are thousands", () => expect(parseMoney("1,234,567", "ZAR")).toBe(123456700));
  test("lone comma with 3 digits is ambiguous", () => expect(parseMoney("1,234", "ZAR")).toBeNull());
});
