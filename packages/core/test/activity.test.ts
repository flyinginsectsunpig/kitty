import { expect, test } from "vitest";
import { describeActivity } from "../src/activity";

test("an expense names its description and amount", () => {
  expect(describeActivity("expense", { description: "Petrol", amountMinor: 60000, currency: "ZAR" })).toMatch(/^expense "Petrol" \(R\s600,00\)$/);
});

test("a settlement is a payment with its amount", () => {
  expect(describeActivity("settlement", { amountMinor: 500, currency: "ZAR" })).toMatch(/^a payment \(R\s5,00\)$/);
});

test("a member is their display name", () => expect(describeActivity("member", { displayName: "Sam" })).toBe("Sam"));

test("a group is named when the snapshot has one", () => {
  expect(describeActivity("group", { name: "Flat" })).toBe('the group "Flat"');
  expect(describeActivity("group", {})).toBe("the group");
});

test("an unknown currency drops the amount instead of throwing", () => {
  expect(describeActivity("expense", { description: "X", amountMinor: 1, currency: "XXX" })).toBe('expense "X"');
});

test("no snapshot falls back to the entity type", () => expect(describeActivity("expense", null)).toBe("expense"));

test("an expense a schedule added says so", () => {
  expect(
    describeActivity("expense", { description: "Rent", amountMinor: 1200000, currency: "ZAR", recurringScheduleId: "s1" }),
  ).toMatch(/^expense "Rent" \(R\s12\s000,00\), added automatically$/);
});

test("a repeating schedule is named", () => {
  expect(describeActivity("recurring", { description: "Rent", amountMinor: 1200000, currency: "ZAR" })).toMatch(
    /^repeating expense "Rent" \(R\s12\s000,00\)$/,
  );
});
