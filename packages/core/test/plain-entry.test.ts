import { describe, expect, test } from "vitest";
import { toExpenseWriteDto } from "../src/expense-form";
import { errorMessage } from "../src/errors";
import {
  aiErrorCode,
  allocateCovers,
  applyPick,
  canSave,
  countingBoth,
  coverLines,
  coverNote,
  draftMoney,
  draftShares,
  draftToForm,
  toggleCover,
  toSettlementWriteDto,
  withCounterpart,
  type OpenItem,
  type PlainDraft,
} from "../src/plain-entry";

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

describe("draftShares", () => {
  test("an equal split shows each person's share, as the ledger will split it", () => {
    const d = expense({
      split: "equal",
      amountMinor: 8500,
      participants: [
        { memberId: "m-sam", name: "Sam", amountMinor: null },
        { memberId: "m-me", name: "me", amountMinor: null },
      ],
    });
    expect(draftShares(d)).toEqual([4250, 4250]);
  });

  test("a one-person debt shows the whole amount on that person", () => {
    const d = expense({ split: "equal", amountMinor: 15000, participants: [{ memberId: "m-joe", name: "Lee", amountMinor: null }] });
    expect(draftShares(d)).toEqual([15000]);
  });

  test("amounts show as given; nothing is guessed while a person or the total is unknown", () => {
    expect(draftShares(expense())).toEqual([5000, 10000, 7000]);
    const unknown = expense({ split: "equal", participants: [{ memberId: null, name: "Thabo", amountMinor: null }, { memberId: "m-me", name: "me", amountMinor: null }] });
    expect(draftShares(unknown)).toEqual([null, null]);
  });
});

const pizza: OpenItem = { expenseId: "e-pizza", description: "Pizza", date: "2026-11-01", openMinor: 2500 };
const uber: OpenItem = { expenseId: "e-uber", description: "Uber", date: "2026-11-10", openMinor: 9500 };

function payment(overrides: Partial<NonNullable<PlainDraft["payment"]>> = {}, issues: PlainDraft["issues"] = []): PlainDraft {
  return {
    intent: "payment",
    groupId: "g-flat",
    issues,
    members,
    groups: [{ id: "g-flat", name: "Flat 4B" }],
    parsed: { counterpart: "Joe", kind: "payment" },
    payment: {
      fromMemberId: "m-joe",
      toMemberId: "m-me",
      currency: "ZAR",
      amountMinor: 2500,
      statedAmountMinor: null,
      openItems: [pizza, uber],
      covers: [{ expenseId: "e-pizza", amountMinor: 2500 }],
      ...overrides,
    },
  };
}

describe("allocateCovers", () => {
  test("oldest first, whole amounts", () => {
    expect(allocateCovers([uber, pizza], ["e-uber", "e-pizza"], null)).toEqual({
      covers: [
        { expenseId: "e-pizza", amountMinor: 2500 },
        { expenseId: "e-uber", amountMinor: 9500 },
      ],
      amountMinor: 12000,
    });
  });

  test("a stated amount stops part-way", () => {
    expect(allocateCovers([pizza, uber], ["e-pizza", "e-uber"], 3000)).toEqual({
      covers: [
        { expenseId: "e-pizza", amountMinor: 2500 },
        { expenseId: "e-uber", amountMinor: 500 },
      ],
      amountMinor: 3000,
    });
  });

  test("an amount below the first item covers part of it", () => {
    expect(allocateCovers([pizza, uber], ["e-pizza", "e-uber"], 1000)).toEqual({
      covers: [{ expenseId: "e-pizza", amountMinor: 1000 }],
      amountMinor: 1000,
    });
  });
});

describe("payment drafts", () => {
  test("toggleCover re-totals", () => {
    const both = toggleCover(payment(), "e-uber");
    expect(both.payment?.covers).toEqual([
      { expenseId: "e-pizza", amountMinor: 2500 },
      { expenseId: "e-uber", amountMinor: 9500 },
    ]);
    expect(both.payment?.amountMinor).toBe(12000);
    const back = toggleCover(both, "e-uber");
    expect(back.payment?.amountMinor).toBe(2500);
  });

  test("picking an ambiguous item ticks it and clears the issue", () => {
    const d = payment(
      { covers: [], amountMinor: null },
      [{ field: "payment.items[0]", kind: "ambiguous", text: "Which one?", candidates: ["e-pizza", "e-uber"] }],
    );
    const next = applyPick(d, 0, "e-uber");
    expect(next.issues).toEqual([]);
    expect(next.payment?.covers).toEqual([{ expenseId: "e-uber", amountMinor: 9500 }]);
    const skipped = applyPick(d, 0, null);
    expect(skipped.issues).toEqual([]);
    expect(skipped.payment?.covers).toEqual([]);
  });

  test("an item ticked but given nothing stays ticked, and gets covered once the amount reaches it", () => {
    const d = payment({ statedAmountMinor: 2500 }); // pays the pizza in full
    const both = toggleCover(d, "e-uber");
    expect(both.payment?.ticked).toEqual(["e-pizza", "e-uber"]);
    expect(both.payment?.covers).toEqual([{ expenseId: "e-pizza", amountMinor: 2500 }]);
    expect(both.payment?.amountMinor).toBe(2500);
    const noPizza = toggleCover(both, "e-pizza");
    expect(noPizza.payment?.ticked).toEqual(["e-uber"]);
    expect(noPizza.payment?.covers).toEqual([{ expenseId: "e-uber", amountMinor: 2500 }]);
  });

  test("the ticked set starts from the ai draft's covers", () => {
    const d = payment();
    expect(d.payment?.ticked).toBeUndefined();
    expect(toggleCover(d, "e-pizza").payment?.ticked).toEqual([]);
  });

  test("picking an item keeps the ones ticked though they get nothing", () => {
    const d = payment(
      { statedAmountMinor: 2500, ticked: ["e-pizza"], covers: [{ expenseId: "e-pizza", amountMinor: 2500 }] },
      [{ field: "payment.items[0]", kind: "ambiguous", text: "Which one?", candidates: ["e-uber"] }],
    );
    const next = applyPick(d, 0, "e-uber");
    expect(next.payment?.ticked).toEqual(["e-pizza", "e-uber"]);
    expect(next.payment?.covers).toEqual([{ expenseId: "e-pizza", amountMinor: 2500 }]);
  });

  test("a stale card asks for the sentence again, not a retry of the same card", () => {
    expect(errorMessage("cover_invalid")).toBe("Something on this list changed. Type it again.");
  });

  test("withCounterpart replaces only the counterpart", () => {
    expect(withCounterpart({ counterpart: "Jo", kind: "payment" }, "Joe Bloggs")).toEqual({ counterpart: "Joe Bloggs", kind: "payment" });
  });

  test("canSave refuses a payment with no covers", () => {
    expect(canSave(payment())).toBe(true);
    expect(canSave(payment({ covers: [] }))).toBe(false);
    expect(canSave(payment({ amountMinor: 1000 }))).toBe(false); // covers sum 2500 > 1000
  });

  test("toSettlementWriteDto sends the covers", () => {
    expect(toSettlementWriteDto(payment(), "s-1")).toEqual({
      id: "s-1",
      fromMemberId: "m-joe",
      toMemberId: "m-me",
      currency: "ZAR",
      amountMinor: 2500,
      paidInGroupCurrency: false,
      covers: [{ expenseId: "e-pizza", amountMinor: 2500 }],
    });
  });
});

describe("coverLines", () => {
  const groceries: OpenItem = { expenseId: "e-groceries", description: "Groceries", date: "2026-11-20", openMinor: 4000 };

  test("says what each ticked item gets, oldest first", () => {
    const ticked = ["e-groceries", "e-uber", "e-pizza"];
    const { covers } = allocateCovers([pizza, uber, groceries], ticked, 5000);
    expect(coverLines([groceries, uber, pizza], ticked, covers)).toEqual([
      { expenseId: "e-pizza", description: "Pizza", openMinor: 2500, coveredMinor: 2500, state: "full" },
      { expenseId: "e-uber", description: "Uber", openMinor: 9500, coveredMinor: 2500, state: "part" },
      { expenseId: "e-groceries", description: "Groceries", openMinor: 4000, coveredMinor: 0, state: "none" },
    ]);
  });

  test("leaves out items that aren't ticked", () => {
    expect(coverLines([pizza, uber], ["e-uber"], [{ expenseId: "e-uber", amountMinor: 9500 }])).toEqual([
      { expenseId: "e-uber", description: "Uber", openMinor: 9500, coveredMinor: 9500, state: "full" },
    ]);
  });

  test("coverNote says nothing for a full cover, the part for a part, and that the payment runs out for none", () => {
    const [full, part, none] = coverLines(
      [pizza, uber, { ...uber, expenseId: "e-later", description: "Later", date: "2026-11-11" }],
      ["e-pizza", "e-uber", "e-later"],
      [
        { expenseId: "e-pizza", amountMinor: 2500 },
        { expenseId: "e-uber", amountMinor: 500 },
      ],
    );
    expect(coverNote(full!, "ZAR")).toBeNull();
    expect(coverNote(part!, "ZAR")).toBe(`Uber: ${draftMoney(500, "ZAR")} of ${draftMoney(9500, "ZAR")}`);
    expect(coverNote(none!, "ZAR")).toBe("Later: not covered, the payment runs out");
  });
});

describe("countingBoth", () => {
  const money = (minor: number) => ({ currency: "ZAR", minor, text: "" });
  const open = (fromOwes: number, toOwes: number) => ({
    fromMemberId: "m-joe",
    toMemberId: "m-me",
    currencies: [{ currency: "ZAR", fromOwes: [], fromOwesTotal: money(fromOwes), toOwes: [], toOwesTotal: money(toOwes) }],
  });

  test("says who owes whom net", () => {
    expect(countingBoth(open(3000, 2500), "ZAR", "m-me", "Joe")).toBe("Counting what Joe owes you, Joe owes you R 5,00.");
    expect(countingBoth(open(2500, 3000), "ZAR", "m-me", "Joe")).toBe("Counting what Joe owes you, you still owe Joe R 5,00.");
    expect(countingBoth(open(2500, 2500), "ZAR", "m-me", "Joe")).toBe("Counting what Joe owes you, you're even.");
  });

  test("is null when only one side is open", () => {
    expect(countingBoth(open(3000, 0), "ZAR", "m-me", "Joe")).toBeNull();
    expect(countingBoth(open(0, 3000), "ZAR", "m-me", "Joe")).toBeNull();
  });
});
