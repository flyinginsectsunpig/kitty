import { auth } from "@/auth/config";

// Runs Auth.js on every page request so expiring Keycloak tokens are refreshed and the cookie re-saved.
const refreshSession = auth(() => undefined);

export default function proxy(...args: Parameters<typeof refreshSession>) {
  return refreshSession(...args);
}

export const config = {
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
};
