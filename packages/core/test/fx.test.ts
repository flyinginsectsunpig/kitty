import { formatMoney } from "@kitty/money";
import { describe, expect, test } from "vitest";
import { describeRate, expenseAmounts } from "../src/fx";
import { errorMessage } from "../src/errors";

describe("describeRate", () => {
  test("an ECB rate names the publication date", () => {
    expect(describeRate({ from: "EUR", to: "ZAR", rate: "19.1987", rateDate: "2026-11-20", source: "ecb" })).toBe(
      "1 EUR = 19.1987 ZAR · ECB, 20 Nov 2026",
    );
  });

  test("a typed rate says so", () => {
    expect(describeRate({ from: "EUR", to: "ZAR", rate: "19.5", rateDate: null, source: "manual" })).toBe(
      "1 EUR = 19.5 ZAR · entered by hand",
    );
  });
});

describe("expenseAmounts", () => {
  const base = { currency: "EUR", amountMinor: 4000, convertedAmountMinor: 76795 as number | null };

  test("a foreign expense shows both amounts", () => {
    expect(expenseAmounts(base, "ZAR")).toBe(`${formatMoney(4000, "EUR")} · ${formatMoney(76795, "ZAR")}`);
  });

  test("a foreign expense without a rate says so", () => {
    expect(expenseAmounts({ ...base, convertedAmountMinor: null }, "ZAR")).toBe(`${formatMoney(4000, "EUR")} · no rate yet`);
  });

  test("the group's own currency shows one amount", () => {
    expect(expenseAmounts({ currency: "ZAR", amountMinor: 12000, convertedAmountMinor: null }, "ZAR")).toBe(formatMoney(12000, "ZAR"));
  });
});

test("errorMessage covers the exchange-rate codes", () => {
  expect(errorMessage("fx_rate_unavailable")).toBe("Couldn't get today's exchange rate. Type the rate instead.");
  expect(errorMessage("fx_rate_required")).toBe("We couldn't look up the exchange rate. Enter it to record this payment.");
  expect(errorMessage("fx_rate_invalid")).toBe("That exchange rate doesn't look right.");
});
