import { describe, expect, test } from "vitest";
import { NOTIFICATION_ROWS, notificationWrite } from "../src/notifications";

describe("NOTIFICATION_ROWS", () => {
  test("rows cover every setting once", () => {
    const fields = NOTIFICATION_ROWS.flatMap((r) => [r.push, r.email]).sort();
    expect(fields).toEqual(
      ["expenseEmail", "expensePush", "paymentEmail", "paymentPush", "reminderEmail", "reminderPush", "weeklyEmail", "weeklyPush"],
    );
  });

  test("labels say what each row is about", () => {
    expect(NOTIFICATION_ROWS.map((r) => [r.kind, r.label])).toEqual([
      ["expense", "Someone adds you to an expense"],
      ["payment", "A payment with you is recorded"],
      ["weekly", "Weekly: what you owe (Mondays)"],
      ["reminder", "Someone reminds you what you owe"],
    ]);
  });
});

describe("notificationWrite", () => {
  const current = {
    expensePush: true, expenseEmail: true, paymentPush: true, paymentEmail: false, weeklyPush: false, weeklyEmail: true,
    reminderPush: true, reminderEmail: true,
    emailAvailable: true,
  };
  const ticked = (...fields: string[]) => (f: string) => fields.includes(f);

  test("takes every switch from the form", () => {
    expect(notificationWrite(ticked("paymentPush", "paymentEmail"), current)).toEqual({
      expensePush: false, expenseEmail: false, paymentPush: true, paymentEmail: true, weeklyPush: false, weeklyEmail: false,
      reminderPush: false, reminderEmail: false,
    });
  });

  test("keeps the email choices while email is unavailable (those switches are disabled, so never sent)", () => {
    expect(notificationWrite(ticked("weeklyPush"), { ...current, emailAvailable: false })).toEqual({
      expensePush: false, expenseEmail: true, paymentPush: false, paymentEmail: false, weeklyPush: true, weeklyEmail: true,
      reminderPush: false, reminderEmail: true,
    });
  });
});
