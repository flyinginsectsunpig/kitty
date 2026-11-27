import "server-only";
import { aiErrorCode, type AskResult, type PlainDraft } from "@kitty/core";
import { getAccessToken } from "@/auth/token";

export type AiResult = { draft: PlainDraft; error?: never } | { draft?: never; error: string };

/** POSTs to the ai service as the signed-in person (it reads the ledger with their token): the JSON, or an error code. */
async function post(path: "/parse" | "/resolve" | "/ask", body: unknown): Promise<{ json: unknown } | { error: string }> {
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
    return { json: await response.json() };
  } catch {
    return { error: "ai_unavailable" };
  }
}

async function call(path: "/parse" | "/resolve", body: unknown): Promise<AiResult> {
  const result = await post(path, body);
  return "error" in result ? { error: result.error } : { draft: result.json as PlainDraft };
}

export const parseSentence = (text: string, groupId?: string) => call("/parse", { text, groupId: groupId ?? null });
export const resolveDraft = (parsed: unknown, groupId: string) => call("/resolve", { parsed, groupId });

/** Ask Kitty: the conversation so far (the last message the person's), and the group the box is in, if any. */
export async function askKitty(messages: { role: "person" | "kitty"; text: string }[], groupId?: string): Promise<AskResult> {
  const result = await post("/ask", { messages, groupId: groupId ?? null });
  if ("error" in result) return { error: result.error };
  const body = result.json as { answer?: string; kind?: string };
  if (body.kind === "entry") return { entry: true };
  return typeof body.answer === "string" ? { answer: body.answer } : { error: "unexpected" };
}

/** An assistant's draft (MCP), opened from its /d/{id} link: the card, resolved afresh for the signed-in person.
 * "draft_gone" when it expired, was used, or was made for someone else. */
export async function getDraft(id: string): Promise<AiResult> {
  const baseUrl = process.env.AI_URL;
  if (!baseUrl) return { error: "ai_unavailable" };
  const token = await getAccessToken();
  if (!token) return { error: "ai_signed_out" };
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/drafts/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (response.status === 404) return { error: "draft_gone" };
    if (!response.ok) return { error: aiErrorCode(response.status) };
    return { draft: (await response.json()) as PlainDraft };
  } catch {
    return { error: "ai_unavailable" };
  }
}

/** After Save or Send: the draft is used, so its link stops working. Failing is harmless (it expires in a day). */
export async function finishDraft(id: string): Promise<void> {
  const baseUrl = process.env.AI_URL;
  const token = await getAccessToken();
  if (!baseUrl || !token) return;
  try {
    await fetch(`${baseUrl.replace(/\/$/, "")}/drafts/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    // It expires on its own.
  }
}
