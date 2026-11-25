import type { NotificationSettingsDto, NotificationSettingsWriteDto } from "@kitty/api-client";

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

/**
 * The settings to save from a form's switches. While email is unavailable its switches are disabled (and a disabled
 * checkbox isn't sent), so the stored email choices are kept rather than read as "off".
 */
export function notificationWrite(isOn: (field: NotificationField) => boolean, current: NotificationSettingsDto): NotificationSettingsWriteDto {
  const write = {} as NotificationSettingsWriteDto;
  for (const row of NOTIFICATION_ROWS) {
    write[row.push] = isOn(row.push);
    write[row.email] = current.emailAvailable ? isOn(row.email) : current[row.email];
  }
  return write;
}
