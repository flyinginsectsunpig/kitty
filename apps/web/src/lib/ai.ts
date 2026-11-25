import "server-only";
import { aiErrorCode, type PlainDraft } from "@kitty/core";
import { getAccessToken } from "@/auth/token";

export type AiResult = { draft: PlainDraft; error?: never } | { draft?: never; error: string };

/** Calls the ai service (plain-language entry) as the signed-in person. It reads the ledger with their token. */
async function call(path: "/parse" | "/resolve", body: unknown): Promise<AiResult> {
  const baseUrl = process.env.AI_URL;
  if (!baseUrl) return { error: "ai_unavailable" };
  const token = await getAccessToken();
  if (!token) return { error: "ai_signed_out" };
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!response.ok) return { error: aiErrorCode(response.status) };
    return { draft: (await response.json()) as PlainDraft };
  } catch {
    return { error: "ai_unavailable" };
  }
}

export const parseSentence = (text: string, groupId?: string) => call("/parse", { text, groupId: groupId ?? null });
export const resolveDraft = (parsed: unknown, groupId: string) => call("/resolve", { parsed, groupId });
