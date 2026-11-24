import type { LedgerClient } from "@kitty/api-client";
import * as ExpoNotifications from "expo-notifications";

type NotificationsApi = Pick<
  typeof ExpoNotifications,
  "AndroidImportance" | "setNotificationChannelAsync" | "getPermissionsAsync" | "requestPermissionsAsync" | "getDevicePushTokenAsync"
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

/** Stops this phone getting the signed-in person's notifications. Does nothing without permission or a token. */
export async function forgetDevice(ledger: LedgerClient, n: NotificationsApi = ExpoNotifications): Promise<void> {
  if (!(await n.getPermissionsAsync()).granted) return;
  const token = await phoneToken(n);
  if (!token) return;
  await ledger.POST("/me/devices/forget", { body: { token } });
}

async function phoneToken(n: NotificationsApi): Promise<string | null> {
  try {
    const t = await n.getDevicePushTokenAsync();
    return t.type === "android" && typeof t.data === "string" ? t.data : null;
  } catch {
    return null; // no google-services.json in this build
  }
}
