import type { RecurringDto } from "@kitty/api-client";
import { formatMoney } from "@kitty/money";
import { describe, expect, test } from "vitest";
import type { ExpenseFormState } from "../src/expense-form";
import { describeRule, describeSchedule, recurringForm, toRecurringWriteDto } from "../src/recurring";

const A = "00000001-0000-0000-0000-000000000000";
const B = "00000002-0000-0000-0000-000000000000";

const form = (overrides: Partial<ExpenseFormState> = {}): ExpenseFormState => ({
  id: "11111111-1111-1111-1111-111111111111",
  version: null,
  description: "Rent",
  category: "rent",
  currency: "ZAR",
  amount: "12000",
  occurredOn: "2026-12-01",
  payerId: A,
  method: "equal",
  participants: [
    { memberId: A, included: true, value: "" },
    { memberId: B, included: true, value: "" },
  ],
  fxRate: "",
  ...overrides,
});

describe("describeRule", () => {
  test("monthly names the day with its ordinal", () => {
    expect(describeRule("monthly", "2026-12-01")).toBe("Every month on the 1st");
    expect(describeRule("monthly", "2026-12-02")).toBe("Every month on the 2nd");
    expect(describeRule("monthly", "2026-12-03")).toBe("Every month on the 3rd");
    expect(describeRule("monthly", "2026-12-11")).toBe("Every month on the 11th");
    expect(describeRule("monthly", "2026-12-22")).toBe("Every month on the 22nd");
  });

  test("29th–31st mention shorter months", () => {
    expect(describeRule("monthly", "2026-12-31")).toBe("Every month on the 31st (the last day in shorter months)");
    expect(describeRule("monthly", "2026-12-29")).toBe("Every month on the 29th (the last day in shorter months)");
  });

  test("weekly names the weekday", () => {
    expect(describeRule("weekly", "2026-11-27")).toBe("Every Friday");
    expect(describeRule("weekly", "2026-11-30")).toBe("Every Monday");
  });
});

describe("toRecurringWriteDto", () => {
  test("takes the template from the expense form and the start from its date", () => {
    expect(toRecurringWriteDto(form(), "monthly", "")).toMatchObject({
      id: "11111111-1111-1111-1111-111111111111",
      description: "Rent",
      amountMinor: 1200000,
      payers: [{ memberId: A, amountMinor: 1200000 }],
      split: { method: "equal" },
      frequency: "monthly",
      startsOn: "2026-12-01",
      endsOn: null,
      version: null,
    });
  });

  test("an end date is passed through", () => {
    expect(toRecurringWriteDto(form(), "weekly", "2027-06-01")).toMatchObject({ frequency: "weekly", endsOn: "2027-06-01" });
  });

  test("end date before start is rejected", () => {
    expect(toRecurringWriteDto(form(), "monthly", "2026-11-30")).toEqual({ error: "The end date can't be before the start date." });
  });

  test("the expense form's own errors come through", () => {
    expect(toRecurringWriteDto(form({ amount: "" }), "monthly", "")).toEqual({ error: "Enter a valid amount." });
  });
});

const dto = (overrides: Partial<RecurringDto> = {}): RecurringDto => ({
  id: "s1",
  description: "Rent",
  category: "rent",
  currency: "ZAR",
  amountMinor: 1200000,
  payers: [{ memberId: A, amountMinor: 1200000 }],
  split: { method: "equal", participants: [{ memberId: A, value: null }, { memberId: B, value: null }] },
  frequency: "monthly",
  startsOn: "2026-12-01",
  endsOn: null,
  paused: false,
  nextDueOn: "2026-12-01",
  lastAddedOn: null,
  version: 2,
  createdBy: "u1",
  ...overrides,
});

describe("describeSchedule", () => {
  test("amount, rule and next due", () => {
    expect(describeSchedule(dto())).toBe(`${formatMoney(1200000, "ZAR")} · Every month on the 1st · next 1 Dec 2026`);
  });

  test("paused", () => {
    expect(describeSchedule(dto({ paused: true, nextDueOn: null }))).toBe(`${formatMoney(1200000, "ZAR")} · Every month on the 1st · paused`);
  });

  test("ended", () => {
    expect(describeSchedule(dto({ nextDueOn: null }))).toBe(`${formatMoney(1200000, "ZAR")} · Every month on the 1st · ended`);
  });
});

test("recurringForm opens a schedule in the expense form", () => {
  const r = recurringForm(dto({ endsOn: "2027-06-01" }), [A, B], A);
  expect(r.frequency).toBe("monthly");
  expect(r.endsOn).toBe("2027-06-01");
  expect(r.form).toMatchObject({ id: "s1", version: 2, amount: "12000.00", occurredOn: "2026-12-01", payerId: A });
  expect(r.form.participants.every((p) => p.included)).toBe(true);
});
