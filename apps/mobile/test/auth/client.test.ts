import { TokenError } from "expo-auth-session";
import { createKeycloakClient } from "../../src/auth/client";
import { SessionRejected } from "../../src/auth/tokens";

const mockRefreshAsync = jest.fn();
jest.mock("expo-auth-session", () => {
  const actual = jest.requireActual("expo-auth-session");
  return {
    ...actual,
    makeRedirectUri: () => "kitty://auth/callback",
    fetchDiscoveryAsync: async () => ({ tokenEndpoint: "http://kc/token" }),
    refreshAsync: (...args: unknown[]) => mockRefreshAsync(...args),
  };
});

test("Keycloak refusing the refresh token is a SessionRejected", async () => {
  mockRefreshAsync.mockRejectedValueOnce(new TokenError({ error: "invalid_grant", error_description: "Token is not active" }));
  await expect(createKeycloakClient("http://kc").refresh("r")).rejects.toBeInstanceOf(SessionRejected);
});

test("no signal is passed on as it is, not as a rejection", async () => {
  mockRefreshAsync.mockRejectedValueOnce(new TypeError("Network request failed"));
  const failure = createKeycloakClient("http://kc").refresh("r");
  await expect(failure).rejects.toBeInstanceOf(TypeError);
});
