import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AuthClient } from "./client";
import { createTokenKeeper, SignedOut, type TokenStore } from "./tokens";

export type AuthStatus = "loading" | "signedOut" | "signedIn";

type AuthValue = {
  status: AuthStatus;
  /** Shown on the sign-in screen after the app had to sign someone out. */
  notice: string | null;
  /** Resolves true once signed in; false when the user cancelled. Throws when sign-in failed. */
  signIn(): Promise<boolean>;
  signOut(): Promise<void>;
  /** A valid access token. Throws SignedOut (and flips status) when the session is gone. */
  getAccessToken(): Promise<string>;
  /**
   * Runs `hook` at each sign-out while the session still works (to forget this phone's push token). A failed or slow
   * hook can't stop the sign-out. Returns the unsubscribe.
   */
  beforeSignOut(hook: () => Promise<void>): () => void;
};

const SIGN_OUT_HOOK_WAIT_MS = 5000;

export const SIGNED_OUT_NOTICE = "You've been signed out. Sign in again.";

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ client, store, children }: { client: AuthClient; store: TokenStore; children: ReactNode }) {
  const keeper = useMemo(() => createTokenKeeper({ store, refresh: (rt) => client.refresh(rt), now: () => Math.floor(Date.now() / 1000) }), [client, store]);
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    keeper.load().then(
      (t) => live && setStatus(t ? "signedIn" : "signedOut"),
      () => live && setStatus("signedOut"),
    );
    return () => {
      live = false;
    };
  }, [keeper]);

  const getAccessToken = useCallback(async () => {
    try {
      return await keeper.getAccessToken();
    } catch (e) {
      if (e instanceof SignedOut) {
        setNotice(SIGNED_OUT_NOTICE);
        setStatus("signedOut");
      }
      throw e;
    }
  }, [keeper]);

  const signIn = useCallback(async () => {
    const tokens = await client.signIn();
    if (!tokens) return false;
    await keeper.save(tokens);
    setNotice(null);
    setStatus("signedIn");
    return true;
  }, [client, keeper]);

  const signOutHooks = useRef(new Set<() => Promise<void>>());
  const beforeSignOut = useCallback((hook: () => Promise<void>) => {
    signOutHooks.current.add(hook);
    return () => void signOutHooks.current.delete(hook);
  }, []);

  const signOut = useCallback(async () => {
    await Promise.allSettled(
      [...signOutHooks.current].map((hook) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const giveUp = new Promise<void>((resolve) => (timer = setTimeout(resolve, SIGN_OUT_HOOK_WAIT_MS)));
        return Promise.race([hook(), giveUp]).finally(() => clearTimeout(timer));
      }),
    );
    const tokens = await keeper.load();
    await keeper.clear();
    setStatus("signedOut");
    // Local sign-out first, so a failed network call can't leave the app signed in.
    await client.signOut(tokens?.idToken).catch(() => {});
  }, [client, keeper]);

  const value = useMemo(
    () => ({ status, notice, signIn, signOut, getAccessToken, beforeSignOut }),
    [status, notice, signIn, signOut, getAccessToken, beforeSignOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider.");
  return value;
}
