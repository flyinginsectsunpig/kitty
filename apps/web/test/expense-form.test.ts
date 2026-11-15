import { describe, expect, test } from "vitest";
import { toExpenseWriteDto, type ExpenseFormState } from "@/lib/expense-form";

const A = "00000001-0000-0000-0000-000000000000";
const B = "00000002-0000-0000-0000-000000000000";

function form(overrides: Partial<ExpenseFormState> = {}): ExpenseFormState {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    version: null,
    description: "Groceries",
    category: "groceries",
    currency: "ZAR",
    amount: "100",
    occurredOn: "2026-11-15",
    payerId: A,
    method: "equal",
    participants: [
      { memberId: A, included: true, value: "" },
      { memberId: B, included: true, value: "" },
    ],
    ...overrides,
  };
}

describe("toExpenseWriteDto", () => {
  test("equal split builds participants with null values", () => {
    const dto = toExpenseWriteDto(form());
    expect(dto).toMatchObject({
      amountMinor: 10000,
      payers: [{ memberId: A, amountMinor: 10000 }],
      split: { method: "equal", participants: [{ memberId: A, value: null }, { memberId: B, value: null }] },
      version: null,
    });
  });

  test("percent converts 33.33 to 3333 basis points", () => {
    const dto = toExpenseWriteDto(
      form({
        method: "percent",
        participants: [
          { memberId: A, included: true, value: "33.33" },
          { memberId: B, included: true, value: "66.67" },
        ],
      }),
    );
    expect("error" in dto ? dto : dto.split.participants.map((p) => p.value)).toEqual([3333, 6667]);
  });

  test("exact amounts are parsed as money", () => {
    const dto = toExpenseWriteDto(
      form({
        method: "exact",
        participants: [
          { memberId: A, included: true, value: "40" },
          { memberId: B, included: true, value: "60,00" },
        ],
      }),
    );
    expect("error" in dto ? dto : dto.split.participants.map((p) => p.value)).toEqual([4000, 6000]);
  });

  test("excluded people are left out", () => {
    const dto = toExpenseWriteDto(form({ participants: [{ memberId: A, included: true, value: "" }, { memberId: B, included: false, value: "" }] }));
    expect("error" in dto ? dto : dto.split.participants.map((p) => p.memberId)).toEqual([A]);
  });

  test("empty participant list is an error", () => {
    const dto = toExpenseWriteDto(form({ participants: [{ memberId: A, included: false, value: "" }] }));
    expect(dto).toEqual({ error: "Pick at least one person to split with." });
  });

  test("invalid amount is an error", () => {
    expect(toExpenseWriteDto(form({ amount: "abc" }))).toEqual({ error: "Enter a valid amount." });
    expect(toExpenseWriteDto(form({ amount: "0" }))).toEqual({ error: "Enter a valid amount." });
  });

  test("invalid share value is an error", () => {
    const dto = toExpenseWriteDto(form({ method: "shares", participants: [{ memberId: A, included: true, value: "1.5" }] }));
    expect(dto).toEqual({ error: "Each person needs a valid share." });
  });

  test("edits carry the version", () => {
    const dto = toExpenseWriteDto(form({ version: 3 }));
    expect("error" in dto ? dto : dto.version).toBe(3);
  });
});
