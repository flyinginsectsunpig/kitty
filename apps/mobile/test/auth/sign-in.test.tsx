import { Slot } from "expo-router";
import { renderRouter, screen, fireEvent, waitFor } from "expo-router/testing-library";
import { useEffect } from "react";
import { Text } from "react-native";
import AppLayout from "../../src/app/(app)/_layout";
import SignIn from "../../src/app/sign-in";
import { AuthProvider, useAuth } from "../../src/auth/AuthProvider";
import type { AuthClient } from "../../src/auth/client";
import { SessionRejected, type TokenStore, type Tokens } from "../../src/auth/tokens";

function memoryStore(): TokenStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v), remove: async (k) => void data.delete(k) };
}

const now = () => Math.floor(Date.now() / 1000);
const good: Tokens = { accessToken: "a", refreshToken: "r", expiresAt: now() + 300, idToken: "id" };

function fakeClient(overrides: Partial<AuthClient> = {}): AuthClient {
  return { signIn: jest.fn(async () => good), refresh: jest.fn(async () => good), signOut: jest.fn(async () => {}), ...overrides };
}

function Groups() {
  const { getAccessToken } = useAuth();
  useEffect(() => {
    getAccessToken().catch(() => {});
  }, [getAccessToken]);
  return <Text>Groups screen</Text>;
}

async function renderApp(client: AuthClient, store: TokenStore, initialUrl = "/groups") {
  return renderRouter(
    {
      _layout: () => (
        <AuthProvider client={client} store={store}>
          <Slot />
        </AuthProvider>
      ),
      "sign-in": SignIn,
      "(app)/_layout": AppLayout,
      "(app)/groups/index": Groups,
    },
    { initialUrl },
  );
}

test("signed-out users land on sign-in", async () => {
  const app = await renderApp(fakeClient(), memoryStore());
  expect(await screen.findByText("Sign in")).toBeTruthy();
  expect(app.getPathname()).toBe("/sign-in");
});

test("cancelled sign-in stores nothing and shows no error", async () => {
  const store = memoryStore();
  await renderApp(fakeClient({ signIn: jest.fn(async () => null) }), store);
  await fireEvent.press(await screen.findByText("Sign in"));
  await waitFor(() => expect(screen.getByText("Sign in")).toBeTruthy());
  expect(store.data.size).toBe(0);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("successful sign-in stores tokens and routes to /groups", async () => {
  const store = memoryStore();
  const app = await renderApp(fakeClient(), store);
  await fireEvent.press(await screen.findByText("Sign in"));
  expect(await screen.findByText("Groups screen")).toBeTruthy();
  expect(app.getPathname()).toBe("/groups");
  expect(store.data.size).toBe(1);
});

test("the signed-out notice is shown after a forced sign-out", async () => {
  const store = memoryStore();
  await store.set("kitty.tokens", JSON.stringify({ ...good, expiresAt: now() - 10 }));
  await renderApp(fakeClient({ refresh: jest.fn(async () => Promise.reject(new SessionRejected("invalid_grant"))) }), store);
  expect(await screen.findByText("You've been signed out. Sign in again.")).toBeTruthy();
  expect(store.data.size).toBe(0);
});

test("a sign-in failure says so", async () => {
  await renderApp(fakeClient({ signIn: jest.fn(async () => Promise.reject(new Error("offline"))) }), memoryStore());
  await fireEvent.press(await screen.findByText("Sign in"));
  expect(await screen.findByRole("alert")).toBeTruthy();
});

test("no signal on start-up keeps the user signed in", async () => {
  const store = memoryStore();
  await store.set("kitty.tokens", JSON.stringify({ ...good, expiresAt: now() - 10 }));
  await renderApp(fakeClient({ refresh: jest.fn(async () => Promise.reject(new TypeError("Network request failed"))) }), store);
  expect(await screen.findByText("Groups screen")).toBeTruthy();
  expect(screen.queryByText("You've been signed out. Sign in again.")).toBeNull();
  expect(store.data.size).toBe(1);
});
