"use server";

import { getToken } from "next-auth/jwt";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { signOut } from "./config";
import { keycloakLogoutUrl } from "./logout";
import { keycloakConfigFromEnv } from "./refresh";

/** Clears the app session, then ends the Keycloak session (important on shared devices). */
export async function signOutEverywhere() {
  const token = await getToken({
    req: { headers: await headers() },
    secret: process.env.AUTH_SECRET!,
    secureCookie: (process.env.AUTH_URL ?? "").startsWith("https://"),
  });
  await signOut({ redirect: false });
  const { issuer, clientId } = keycloakConfigFromEnv();
  redirect(keycloakLogoutUrl(issuer, token?.idToken as string | undefined, process.env.AUTH_URL ?? "http://localhost:3000", clientId));
}
