import { Redirect, Stack, useGlobalSearchParams, usePathname, useSegments } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { useAuth } from "../../auth/AuthProvider";
import { useLedger } from "../../ledger";
import { forgetDevice, registerDevice } from "../../notifications/registerDevice";
import { useNotificationLinks } from "../../notifications/useNotificationLinks";

/** Everything except sign-in needs a session; a signed-out visitor is sent to sign in and brought back after. */
export default function AppLayout() {
  const { status } = useAuth();
  const pathname = usePathname();
  const segments = useSegments();
  const params = useGlobalSearchParams();
  if (status === "loading")
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  if (status === "signedOut") {
    const next = here(pathname, segments, params);
    return <Redirect href={{ pathname: "/sign-in", params: next === "/groups" ? {} : { next } }} />;
  }
  return <SignedIn />;
}

/** Push: this phone gets the person's notifications while they're signed in, and a tapped one opens its page. */
function SignedIn() {
  const ledger = useLedger();
  const { beforeSignOut } = useAuth();
  useNotificationLinks();
  useEffect(() => {
    registerDevice(ledger).catch(() => {}); // tried again at the next start; the app works without push
    return beforeSignOut(() => forgetDevice(ledger));
  }, [ledger, beforeSignOut]);
  // A group's screens have their own stack (and header, named after the group): no second header above it.
  return (
    <Stack>
      <Stack.Screen name="groups/[id]" options={{ headerShown: false }} />
    </Stack>
  );
}

/** The current link, query included (a table QR link's ?g= says which group), without the route's own [params]. */
function here(pathname: string, segments: string[], params: Record<string, string | string[] | undefined>): string {
  const routeParams = new Set(segments.filter((s) => s.startsWith("[")).map((s) => s.replace(/^\[\.{0,3}|\]$/g, "")));
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (routeParams.has(key) || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) query.append(key, v);
  }
  const search = query.toString();
  return search ? `${pathname}?${search}` : pathname;
}
