import type { LedgerClient } from "@kitty/api-client";
import * as ExpoNotifications from "expo-notifications";

type NotificationsApi = Pick<
  typeof ExpoNotifications,
  | "AndroidImportance"
  | "setNotificationChannelAsync"
  | "getPermissionsAsync"
  | "requestPermissionsAsync"
  | "getDevicePushTokenAsync"
  | "unregisterForNotificationsAsync"
>;

/** The Android channel Kitty's notifications arrive on (also the manifest's default, in app.config.ts). */
export const CHANNEL_ID = "default";

/**
 * Asks to send notifications and gives the ledger this phone's Firebase token. "unavailable": the app was built without
 * Firebase config (or isn't on Android), so there's no token. Throws when the ledger can't be reached.
 */
export async function registerDevice(
  ledger: LedgerClient,
  n: NotificationsApi = ExpoNotifications,
): Promise<"registered" | "denied" | "unavailable"> {
  // Android 13+ only asks once a channel exists.
  await n.setNotificationChannelAsync(CHANNEL_ID, { name: "Kitty", importance: n.AndroidImportance.DEFAULT });
  let permission = await n.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) permission = await n.requestPermissionsAsync();
  if (!permission.granted) return "denied";

  const token = await phoneToken(n);
  if (!token) return "unavailable";
  const { error, response } = await ledger.POST("/me/devices", { body: { token, platform: "android" } });
  if (error !== undefined || !response.ok) throw new Error(`Couldn't register this phone (${response.status}).`);
  return "registered";
}

/**
 * Stops this phone getting the signed-in person's notifications: tells the ledger, then deletes the phone's token, so
 * even when the ledger can't be reached (offline) pulse forgets it at the next push. The next sign-in gets a new one.
 */
export async function forgetDevice(ledger: LedgerClient, n: NotificationsApi = ExpoNotifications): Promise<void> {
  const token = await phoneToken(n); // with or without permission: it may have been switched off since
  if (!token) return;
  try {
    await ledger.POST("/me/devices/forget", { body: { token } });
  } finally {
    await n.unregisterForNotificationsAsync().catch(() => {});
  }
}

async function phoneToken(n: NotificationsApi): Promise<string | null> {
  try {
    const t = await n.getDevicePushTokenAsync();
    return t.type === "android" && typeof t.data === "string" ? t.data : null;
  } catch {
    return null; // no google-services.json in this build
  }
}
