import { createLedgerClient, type LedgerClient } from "@kitty/api-client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAuth } from "./auth/AuthProvider";
import { config } from "./config";

const LedgerContext = createContext<LedgerClient | null>(null);

/** The ledger API client for the signed-in user. Tests pass their own `client` (a real client over a fake fetch). */
export function LedgerProvider({ client, children }: { client?: LedgerClient; children: ReactNode }) {
  const { getAccessToken } = useAuth();
  const value = useMemo(() => client ?? createLedgerClient(config.apiUrl, getAccessToken), [client, getAccessToken]);
  return <LedgerContext.Provider value={value}>{children}</LedgerContext.Provider>;
}

export function useLedger(): LedgerClient {
  const value = useContext(LedgerContext);
  if (!value) throw new Error("useLedger must be used inside LedgerProvider.");
  return value;
}
