import { createLedgerClient, type LedgerClient } from "@kitty/api-client";
import { randomUUID } from "expo-crypto";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAuth } from "./auth/AuthProvider";
import { config } from "./config";

const LedgerContext = createContext<LedgerClient | null>(null);

/** The app's ledger client. Idempotency keys come from expo-crypto: React Native has no global `crypto`. */
export function makeLedgerClient(baseUrl: string, getToken: () => Promise<string>, fetchFn?: (request: Request) => Promise<Response>): LedgerClient {
  return createLedgerClient(baseUrl, getToken, fetchFn, randomUUID);
}

/** The ledger API client for the signed-in user. Tests pass their own `client` (a real client over a fake fetch). */
export function LedgerProvider({ client, children }: { client?: LedgerClient; children: ReactNode }) {
  const { getAccessToken } = useAuth();
  const value = useMemo(() => client ?? makeLedgerClient(config.apiUrl, getAccessToken), [client, getAccessToken]);
  return <LedgerContext.Provider value={value}>{children}</LedgerContext.Provider>;
}

export function useLedger(): LedgerClient {
  const value = useContext(LedgerContext);
  if (!value) throw new Error("useLedger must be used inside LedgerProvider.");
  return value;
}
