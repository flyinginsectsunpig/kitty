/** Keycloak tokens as the app keeps them. `expiresAt` is the access token's expiry in epoch seconds. */
export type Tokens = { accessToken: string; refreshToken: string; expiresAt: number; idToken?: string };

export type TokenStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};

export type TokenDeps = {
  /** The OS secure store in the app (expo-secure-store); a map in tests. Nothing else ever holds tokens. */
  store: TokenStore;
  /** Throws SessionRejected when Keycloak refuses the session; any other error (no signal) is temporary. */
  refresh: (refreshToken: string) => Promise<Tokens>;
  /** Epoch seconds. */
  now: () => number;
};

/** The viewer has no usable session: sign in again. */
export class SignedOut extends Error {
  constructor() {
    super("Signed out");
    this.name = "SignedOut";
  }
}

/** Keycloak refused the refresh (expired or revoked session): signing in again is the only way back. */
export class SessionRejected extends Error {
  constructor(reason: string) {
    super(`Session rejected: ${reason}`);
    this.name = "SessionRejected";
  }
}

const KEY = "kitty.tokens";
/** Refresh this long before expiry, so a request never leaves with a token about to lapse. */
const REFRESH_MARGIN_S = 60;

/**
 * Hands out a valid access token, refreshing on demand rather than on a timer (timers don't run while the app is
 * in the background, so an app reopened hours later refreshes on its first request). Concurrent callers share one
 * refresh. Only a refresh Keycloak refuses forgets the session; one that fails for lack of signal keeps it, and the
 * next request tries again.
 */
export function createTokenKeeper(deps: TokenDeps) {
  let refreshing: Promise<Tokens> | null = null;

  const load = async (): Promise<Tokens | null> => {
    const raw = await deps.store.get(KEY);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  };
  const save = (t: Tokens) => deps.store.set(KEY, JSON.stringify(t));
  const clear = () => deps.store.remove(KEY);

  const refreshOnce = (refreshToken: string): Promise<Tokens> => {
    refreshing ??= (async () => {
      try {
        const next = await deps.refresh(refreshToken);
        await save(next);
        return next;
      } catch (e) {
        if (!(e instanceof SessionRejected)) throw e; // offline or a server hiccup: keep the session
        await clear();
        throw new SignedOut();
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };

  const getAccessToken = async (): Promise<string> => {
    if (refreshing) return (await refreshing).accessToken;
    const current = await load();
    if (!current) throw new SignedOut();
    if (current.expiresAt - deps.now() > REFRESH_MARGIN_S) return current.accessToken;
    return (await refreshOnce(current.refreshToken)).accessToken;
  };

  return { load, save, clear, getAccessToken };
}

export type TokenKeeper = ReturnType<typeof createTokenKeeper>;
