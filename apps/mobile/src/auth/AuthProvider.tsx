import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
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
};

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

  const signOut = useCallback(async () => {
    const tokens = await keeper.load();
    await keeper.clear();
    setStatus("signedOut");
    // Local sign-out first, so a failed network call can't leave the app signed in.
    await client.signOut(tokens?.idToken).catch(() => {});
  }, [client, keeper]);

  const value = useMemo(() => ({ status, notice, signIn, signOut, getAccessToken }), [status, notice, signIn, signOut, getAccessToken]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider.");
  return value;
}
