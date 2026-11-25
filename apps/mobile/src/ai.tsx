import { aiErrorCode, type PlainDraft } from "@kitty/core";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAuth } from "./auth/AuthProvider";
import { config } from "./config";

export type AiResult = { draft: PlainDraft; error?: never } | { draft?: never; error: string };

/** Plain-language entry: the ai service reads a sentence for the signed-in person (it reads the ledger as them). */
export type AiClient = {
  parse(text: string, groupId?: string): Promise<AiResult>;
  resolve(parsed: unknown, groupId: string): Promise<AiResult>;
};

export function makeAiClient(baseUrl: string, getToken: () => Promise<string>, fetchFn: typeof fetch = fetch): AiClient {
  const call = async (path: string, body: unknown): Promise<AiResult> => {
    try {
      const response = await fetchFn(`${baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken()}` },
        body: JSON.stringify(body),
      });
      if (!response.ok) return { error: aiErrorCode(response.status) };
      return { draft: (await response.json()) as PlainDraft };
    } catch {
      return { error: "ai_unavailable" };
    }
  };
  return {
    parse: (text, groupId) => call("/parse", { text, groupId: groupId ?? null }),
    resolve: (parsed, groupId) => call("/resolve", { parsed, groupId }),
  };
}

const AiContext = createContext<AiClient | null>(null);

/** Tests pass their own client; the app builds one from config and the signed-in session. */
export function AiProvider({ client, children }: { client?: AiClient; children: ReactNode }) {
  const { getAccessToken } = useAuth();
  const value = useMemo(() => client ?? makeAiClient(config.aiUrl, getAccessToken), [client, getAccessToken]);
  return <AiContext.Provider value={value}>{children}</AiContext.Provider>;
}

export function useAi(): AiClient {
  const value = useContext(AiContext);
  if (!value) throw new Error("useAi must be used inside AiProvider.");
  return value;
}
