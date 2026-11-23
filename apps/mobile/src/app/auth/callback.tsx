import { Redirect } from "expo-router";

/**
 * Keycloak sends the browser back to kitty://auth/callback after sign-in and sign-out. The sign-in code itself is
 * read by expo-auth-session; Android also opens the app at this path, so it needs a screen: go home, and the auth
 * gate sends a signed-out visitor on to sign-in.
 */
export default function AuthCallback() {
  return <Redirect href="/" />;
}
