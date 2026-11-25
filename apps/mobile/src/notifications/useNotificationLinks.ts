import * as ExpoNotifications from "expo-notifications";
import { useRouter, type Href } from "expo-router";
import { useEffect } from "react";

type NotificationsApi = Pick<typeof ExpoNotifications, "addNotificationResponseReceivedListener" | "getLastNotificationResponseAsync">;

/** The app path a notification's kitty:// link opens: only the group list or one group. */
export function linkPath(link: unknown): string | null {
  if (typeof link !== "string" || !link.startsWith("kitty://")) return null;
  const path = "/" + link.slice("kitty://".length);
  return /^\/groups(\/[0-9A-Za-z-]+)?$/.test(path) ? path : null;
}

// A tapped notification is opened once, even when this hook mounts again (say, after signing back in).
const opened = new Set<string>();

/** Opens a tapped notification's page: one tapped while the app runs, or the one that started it. */
export function useNotificationLinks(n: NotificationsApi = ExpoNotifications) {
  const router = useRouter();
  useEffect(() => {
    let live = true;
    const open = (r: ExpoNotifications.NotificationResponse | null) => {
      if (!live || !r || opened.has(r.notification.request.identifier)) return;
      opened.add(r.notification.request.identifier);
      const path = linkPath(r.notification.request.content.data?.link);
      if (path) router.push(path as Href);
    };
    n.getLastNotificationResponseAsync().then(open, () => {});
    const sub = n.addNotificationResponseReceivedListener(open);
    return () => {
      live = false;
      sub.remove();
    };
  }, [n, router]);
}
