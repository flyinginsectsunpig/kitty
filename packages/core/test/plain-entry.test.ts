import { describe, expect, test } from "vitest";
import { toExpenseWriteDto } from "../src/expense-form";
import { errorMessage } from "../src/errors";
import { aiErrorCode, applyPick, canSave, draftToForm, type PlainDraft } from "../src/plain-entry";

const members = [
  { id: "m-me", displayName: "Zakhir" },
  { id: "m-joe", displayName: "Joe" },
  { id: "m-john", displayName: "John" },
  { id: "m-sam", displayName: "Sam" },
];

function expense(overrides: Partial<NonNullable<PlainDraft["expense"]>> = {}, issues: PlainDraft["issues"] = []): PlainDraft {
  return {
    intent: "expense",
    groupId: "g-flat",
    issues,
    members,
    groups: [{ id: "g-flat", name: "Flat 4B" }],
    parsed: {},
    expense: {
      description: "Dinner",
      category: "food",
      currency: "ZAR",
      amountMinor: 22000,
      occurredOn: "2026-11-25",
      payerMemberId: "m-me",
      split: "amounts",
      participants: [
        { memberId: "m-me", name: "me", amountMinor: 5000 },
        { memberId: "m-joe", name: "Joe", amountMinor: 10000 },
        { memberId: "m-john", name: "John", amountMinor: 7000 },
      ],
      ...overrides,
    },
  };
}

describe("draftToForm", () => {
  test("a split by amounts becomes the form's exact split, with everyone else left out", () => {
    const form = draftToForm(expense(), { id: "e-1" });
    expect(form).toMatchObject({ id: "e-1", description: "Dinner", amount: "220.00", method: "exact", payerId: "m-me", category: "food" });
    expect(form.participants).toEqual([
      { memberId: "m-me", included: true, value: "50.00" },
      { memberId: "m-joe", included: true, value: "100.00" },
      { memberId: "m-john", included: true, value: "70.00" },
      { memberId: "m-sam", included: false, value: "" },
    ]);
    expect(toExpenseWriteDto(form)).toMatchObject({ amountMinor: 22000, split: { method: "exact" } });
  });

  test("an equal split includes exactly the people named", () => {
    const d = expense({
      split: "equal",
      amountMinor: 60000,
      participants: [
        { memberId: "m-me", name: "me", amountMinor: null },
        { memberId: "m-sam", name: "Sam", amountMinor: null },
      ],
    });
    const form = draftToForm(d, { id: "e-2" });
    expect(form.method).toBe("equal");
    expect(form.participants.filter((p) => p.included).map((p) => p.memberId)).toEqual(["m-me", "m-sam"]);
  });

  test("a missing amount leaves the field empty for the person to fill in", () => {
    expect(draftToForm(expense({ amountMinor: null, split: "equal" }), { id: "e-3" }).amount).toBe("");
  });
});

describe("applyPick", () => {
  const thabo = expense(
    {
      split: "amounts",
      participants: [
        { memberId: "m-me", name: "me", amountMinor: 5000 },
        { memberId: null, name: "Thabo", amountMinor: 3000 },
        { memberId: null, name: "Jo", amountMinor: 2000 },
      ],
      amountMinor: 10000,
    },
    [
      { field: "people[1]", kind: "no_match", text: "Thabo", candidates: [] },
      { field: "people[2]", kind: "ambiguous", text: "Jo", candidates: ["m-joe", "m-john"] },
    ],
  );

  test("picking a member settles that issue", () => {
    const d = applyPick(thabo, 1, "m-john");
    expect(d.expense!.participants[2]?.memberId).toBe("m-john");
    expect(d.issues.map((i) => i.field)).toEqual(["people[1]"]);
  });

  test("leaving someone out takes their amount off the total and renumbers the other issues", () => {
    const d = applyPick(thabo, 0, null);
    expect(d.expense!.participants.map((p) => p.name)).toEqual(["me", "Jo"]);
    expect(d.expense!.amountMinor).toBe(7000);
    expect(d.issues).toEqual([{ field: "people[1]", kind: "ambiguous", text: "Jo", candidates: ["m-joe", "m-john"] }]);
  });

  test("leaving someone out of an equal split keeps the total", () => {
    const d = expense(
      { split: "equal", amountMinor: 9000, participants: [{ memberId: "m-me", name: "me", amountMinor: null }, { memberId: null, name: "Thabo", amountMinor: null }] },
      [{ field: "people[1]", kind: "no_match", text: "Thabo", candidates: [] }],
    );
    const after = applyPick(d, 0, null);
    expect(after.expense!.amountMinor).toBe(9000);
    expect(after.expense!.participants).toHaveLength(1);
  });
});

describe("canSave", () => {
  test("false while an issue is open, true once settled", () => {
    const d = expense({}, [{ field: "people[1]", kind: "ambiguous", text: "Jo", candidates: ["m-joe", "m-john"] }]);
    expect(canSave(d)).toBe(false);
    expect(canSave(applyPick(d, 0, "m-joe"))).toBe(true);
  });

  test("false without an amount, or for an unclear sentence", () => {
    expect(canSave(expense({ amountMinor: null }))).toBe(false);
    expect(canSave({ ...expense(), intent: "unclear" })).toBe(false);
  });

  test("a reminder needs the person", () => {
    const r: PlainDraft = {
      intent: "reminder",
      groupId: "g-flat",
      issues: [],
      members,
      groups: [],
      parsed: {},
      reminder: { memberId: "m-sam", name: "Sam", owedMinorByCurrency: { ZAR: 15000 }, statedAmountMinor: 2000, statedCurrency: "ZAR" },
    };
    expect(canSave(r)).toBe(true);
    expect(canSave({ ...r, reminder: { ...r.reminder!, memberId: null } })).toBe(false);
  });
});

describe("aiErrorCode", () => {
  test("maps the ai service's answers to messages the box can show", () => {
    expect([401, 404, 422, 429, 503, 400, 500].map(aiErrorCode)).toEqual([
      "ai_signed_out",
      "not_found",
      "unclear",
      "ai_rate_limited",
      "ai_unavailable",
      "sentence_invalid",
      "unexpected",
    ]);
    for (const code of ["ai_signed_out", "unclear", "ai_rate_limited", "ai_unavailable", "sentence_invalid", "nothing_owed", "no_account", "already_reminded"]) {
      expect(errorMessage(code)).not.toBe("Something went wrong. Please try again.");
    }
  });
});
