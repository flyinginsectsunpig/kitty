import type { LedgerClient } from "@kitty/api-client";
import { Slot } from "expo-router";
import { renderRouter } from "expo-router/testing-library";
import type { ComponentType } from "react";
import AppLayout from "../../src/app/(app)/_layout";
import { AuthProvider } from "../../src/auth/AuthProvider";
import type { AuthClient } from "../../src/auth/client";
import type { TokenStore } from "../../src/auth/tokens";
import { AiProvider, type AiClient } from "../../src/ai";
import { LedgerProvider } from "../../src/ledger";

export function memoryStore(): TokenStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v), remove: async (k) => void data.delete(k) };
}

export const fakeAuthClient = (): AuthClient => ({
  signIn: jest.fn(async () => null),
  refresh: jest.fn(async () => Promise.reject(new Error("no refresh in tests"))),
  signOut: jest.fn(async () => {}),
});

/** Renders signed-in app routes (keys under "(app)/") against a fake ledger. */
export async function renderApp(routes: Record<string, ComponentType<any>>, ledger: LedgerClient, initialUrl: string, ai?: AiClient) {
  const store = memoryStore();
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  await store.set("kitty.tokens", JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt, idToken: "id" }));
  const authClient = fakeAuthClient();
  const app = await renderRouter(
    {
      _layout: () => (
        <AuthProvider client={authClient} store={store}>
          <LedgerProvider client={ledger}>
            <AiProvider client={ai}>
              <Slot />
            </AiProvider>
          </LedgerProvider>
        </AuthProvider>
      ),
      "(app)/_layout": AppLayout,
      "sign-in": () => null,
      ...routes,
    },
    { initialUrl },
  );
  return { app, store, authClient };
}
