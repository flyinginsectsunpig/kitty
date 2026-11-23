import { Redirect, Stack, usePathname } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { useAuth } from "../../auth/AuthProvider";

/** Everything except sign-in needs a session; a signed-out visitor is sent to sign in and brought back after. */
export default function AppLayout() {
  const { status } = useAuth();
  const pathname = usePathname();
  if (status === "loading")
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  if (status === "signedOut") return <Redirect href={{ pathname: "/sign-in", params: pathname === "/groups" ? {} : { next: pathname } }} />;
  return <Stack />;
}
