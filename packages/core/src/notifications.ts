import type { NotificationSettingsDto } from "@kitty/api-client";

export type NotificationField = Exclude<keyof NotificationSettingsDto, "emailAvailable">;

/** The notification settings screen: one row per kind of news, a push and an email switch each. */
export const NOTIFICATION_ROWS: readonly {
  kind: "expense" | "payment" | "weekly";
  label: string;
  push: NotificationField;
  email: NotificationField;
}[] = [
  { kind: "expense", label: "Someone adds you to an expense", push: "expensePush", email: "expenseEmail" },
  { kind: "payment", label: "A payment with you is recorded", push: "paymentPush", email: "paymentEmail" },
  { kind: "weekly", label: "Weekly: what you owe (Mondays)", push: "weeklyPush", email: "weeklyEmail" },
];
