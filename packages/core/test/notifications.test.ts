import { describe, expect, test } from "vitest";
import { NOTIFICATION_ROWS } from "../src/notifications";

describe("NOTIFICATION_ROWS", () => {
  test("rows cover every setting once", () => {
    const fields = NOTIFICATION_ROWS.flatMap((r) => [r.push, r.email]).sort();
    expect(fields).toEqual(
      ["expenseEmail", "expensePush", "paymentEmail", "paymentPush", "weeklyEmail", "weeklyPush"],
    );
  });

  test("labels say what each row is about", () => {
    expect(NOTIFICATION_ROWS.map((r) => [r.kind, r.label])).toEqual([
      ["expense", "Someone adds you to an expense"],
      ["payment", "A payment with you is recorded"],
      ["weekly", "Weekly: what you owe (Mondays)"],
    ]);
  });
});
