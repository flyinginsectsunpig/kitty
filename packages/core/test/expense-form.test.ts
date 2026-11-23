import { describe, expect, test } from "vitest";
import { editExpenseForm, newExpenseForm, splitProblemMessage, toExpenseWriteDto, type ExpenseFormState } from "../src/expense-form";

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

describe("newExpenseForm", () => {
  test("starts with everyone included, equal split, the group currency and me paying", () => {
    expect(newExpenseForm({ id: "e", today: "2026-11-23", currency: "ZAR", meId: A, memberIds: [A, B] })).toEqual({
      id: "e",
      version: null,
      description: "",
      category: "other",
      currency: "ZAR",
      amount: "",
      occurredOn: "2026-11-23",
      payerId: A,
      method: "equal",
      participants: [
        { memberId: A, included: true, value: "" },
        { memberId: B, included: true, value: "" },
      ],
    });
  });
});

describe("editExpenseForm", () => {
  const expense = (method: "exact" | "percent" | "shares", values: [number, number]) => ({
    id: "e1",
    version: 4,
    description: "Dinner",
    category: "food",
    currency: "ZAR",
    amountMinor: 12345,
    occurredOn: "2026-11-20",
    payers: [{ memberId: B, amountMinor: 12345 }],
    split: { method, participants: [{ memberId: A, value: values[0] }, { memberId: B, value: values[1] }] },
  });

  test("an exact split shows amounts as decimals", () => {
    const f = editExpenseForm(expense("exact", [2345, 10000]), [A, B], A);
    expect(f).toMatchObject({ id: "e1", version: 4, amount: "123.45", payerId: B, method: "exact" });
    expect(f.participants).toEqual([
      { memberId: A, included: true, value: "23.45" },
      { memberId: B, included: true, value: "100.00" },
    ]);
  });

  test("a percent split shows basis points as percentages", () => {
    expect(editExpenseForm(expense("percent", [3333, 6667]), [A, B], A).participants.map((p) => p.value)).toEqual(["33.33", "66.67"]);
  });

  test("a shares split shows whole shares", () => {
    expect(editExpenseForm(expense("shares", [1, 2]), [A, B], A).participants.map((p) => p.value)).toEqual(["1", "2"]);
  });

  test("members not on the expense are listed but left out", () => {
    const C = "00000003-0000-0000-0000-000000000000";
    expect(editExpenseForm(expense("shares", [1, 2]), [A, B, C], A).participants[2]).toEqual({ memberId: C, included: false, value: "" });
  });

  test("an itemized expense can't be shown in the form", () => {
    const itemized = { ...expense("exact", [1, 1]), split: { method: "itemized" as const, participants: [] } };
    expect(() => editExpenseForm(itemized, [A, B], A)).toThrow("itemized");
  });

  test("an expense with no payer falls back to me", () => {
    expect(editExpenseForm({ ...expense("exact", [1, 1]), payers: [] }, [A, B], A).payerId).toBe(A);
  });
});

describe("splitProblemMessage", () => {
  test("names the split problems in words", () => {
    expect(splitProblemMessage("split_sum_mismatch")).toBe("The split must add up to the total.");
    expect(splitProblemMessage("split_invalid_value")).toBe("Each person needs a positive number.");
    expect(splitProblemMessage("other")).toBe("Check the split.");
  });
});
