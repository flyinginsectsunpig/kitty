import { describe, expect, test, vi } from "vitest";
import { refreshAccessToken, type AuthToken } from "@/auth/refresh";

const cfg = { issuer: "http://kc.test/realms/kitty", clientId: "kitty-web", clientSecret: "s3cret" };
const now = 1_800_000_000;

function tokenResponse(status: number, body: object) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("refreshAccessToken", () => {
  test("does not refresh a fresh token", async () => {
    const fetchFn = tokenResponse(200, {});
    const token: AuthToken = { accessToken: "a1", refreshToken: "r1", expiresAt: now + 300 };
    expect(await refreshAccessToken(token, now, fetchFn, cfg)).toBe(token);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("refreshes a token about to expire", async () => {
    const fetchFn = tokenResponse(200, { access_token: "a2", refresh_token: "r2", expires_in: 300 });
    const refreshed = await refreshAccessToken({ accessToken: "a1", refreshToken: "r1", expiresAt: now + 10 }, now, fetchFn, cfg);

    expect(refreshed).toMatchObject({ accessToken: "a2", refreshToken: "r2", expiresAt: now + 300 });
    expect(refreshed.error).toBeUndefined();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("http://kc.test/realms/kitty/protocol/openid-connect/token");
    const body = new URLSearchParams(String(init!.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("r1");
    expect(body.get("client_id")).toBe("kitty-web");
  });

  test("keeps the old refresh token when Keycloak does not rotate it", async () => {
    const fetchFn = tokenResponse(200, { access_token: "a2", expires_in: 300 });
    const refreshed = await refreshAccessToken({ accessToken: "a1", refreshToken: "r1", expiresAt: now }, now, fetchFn, cfg);
    expect(refreshed.refreshToken).toBe("r1");
  });

  test("marks error when refresh fails", async () => {
    const fetchFn = tokenResponse(400, { error: "invalid_grant" });
    const refreshed = await refreshAccessToken({ accessToken: "a1", refreshToken: "r1", expiresAt: now - 5 }, now, fetchFn, cfg);
    expect(refreshed.error).toBe("RefreshAccessTokenError");
  });

  test("marks error when there is no refresh token", async () => {
    const refreshed = await refreshAccessToken({ accessToken: "a1", expiresAt: now - 5 }, now, tokenResponse(200, {}), cfg);
    expect(refreshed.error).toBe("RefreshAccessTokenError");
  });
});
