import { createTokenKeeper, SessionRejected, SignedOut, type TokenDeps, type Tokens } from "../../src/auth/tokens";

function memoryStore() {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k: string) => data.get(k) ?? null,
    set: async (k: string, v: string) => void data.set(k, v),
    remove: async (k: string) => void data.delete(k),
  };
}

const NOW = 1_000_000;
const tokens = (accessToken: string, expiresAt: number): Tokens => ({ accessToken, refreshToken: `r-${accessToken}`, expiresAt, idToken: "id" });

function keeper(overrides: Partial<TokenDeps> = {}) {
  const store = memoryStore();
  const refresh = jest.fn(async (_refreshToken: string) => tokens("fresh", NOW + 300));
  const k = createTokenKeeper({ store, refresh, now: () => NOW, ...overrides });
  return { k, store, refresh };
}

test("getAccessToken returns the stored token while it has more than 60 s left", async () => {
  const { k, refresh } = keeper();
  await k.save(tokens("old", NOW + 61));
  expect(await k.getAccessToken()).toBe("old");
  expect(refresh).not.toHaveBeenCalled();
});

test("getAccessToken refreshes when the token expires within 60 s", async () => {
  const { k, refresh, store } = keeper();
  await k.save(tokens("old", NOW + 60));
  expect(await k.getAccessToken()).toBe("fresh");
  expect(refresh).toHaveBeenCalledWith("r-old");
  expect((await k.load())?.accessToken).toBe("fresh");
  expect([...store.data.values()].join()).toContain("fresh");
});

test("two concurrent calls refresh once", async () => {
  const { k, refresh } = keeper();
  await k.save(tokens("old", NOW - 1));
  const [a, b] = await Promise.all([k.getAccessToken(), k.getAccessToken()]);
  expect([a, b]).toEqual(["fresh", "fresh"]);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test("a refresh Keycloak rejects clears the store and throws SignedOut", async () => {
  const { k, store } = keeper({ refresh: async () => Promise.reject(new SessionRejected("invalid_grant")) });
  await k.save(tokens("old", NOW - 1));
  await expect(k.getAccessToken()).rejects.toBeInstanceOf(SignedOut);
  expect(store.data.size).toBe(0);
});

test("a refresh that fails for lack of signal keeps the session and can be retried", async () => {
  let offline = true;
  const refresh = jest.fn(async () => {
    if (offline) throw new TypeError("Network request failed");
    return tokens("fresh", NOW + 300);
  });
  const { k, store } = keeper({ refresh });
  await k.save(tokens("old", NOW - 1));
  await expect(k.getAccessToken()).rejects.toThrow("Network request failed");
  await expect(k.getAccessToken()).rejects.not.toBeInstanceOf(SignedOut);
  expect(store.data.size).toBe(1); // still signed in
  offline = false;
  expect(await k.getAccessToken()).toBe("fresh");
});

test("nothing stored throws SignedOut", async () => {
  const { k } = keeper();
  await expect(k.getAccessToken()).rejects.toBeInstanceOf(SignedOut);
});
