// Ask Kitty: the box becomes a short conversation. The first message goes to /parse (which also spots questions);
// once a conversation is open every message goes to /ask, and an "entry" answer sends it back to /parse once.
import type { PlainDraft } from "./plain-entry";

export type Turn =
  | { role: "person"; text: string }
  | { role: "kitty"; text: string }
  | { role: "draft"; draft: PlainDraft }
  | { role: "error"; code: string };

export type AskResult = { answer: string } | { entry: true } | { error: string };

export const MAX_ASK_MESSAGES = 12;
export const MAX_PERSON_TEXT = 500;
export const MAX_KITTY_TEXT = 4000;

/** What /ask is sent: the person's and Kitty's lines only, Kitty's cut to the limit, the last 12. */
export function askMessages(turns: Turn[]): { role: "person" | "kitty"; text: string }[] {
  const lines: { role: "person" | "kitty"; text: string }[] = [];
  for (const t of turns) {
    if (t.role === "person") lines.push({ role: "person", text: t.text.trim() });
    else if (t.role === "kitty") lines.push({ role: "kitty", text: t.text.slice(0, MAX_KITTY_TEXT) });
  }
  return lines.slice(-MAX_ASK_MESSAGES);
}

/**
 * Where a new message goes: /ask once a conversation is open (Kitty has answered a question), else /parse. Entries,
 * cards and errors don't open one, so adding expenses one after another never costs a question.
 */
export function routeFirst(turns: Turn[]): "parse" | "ask" {
  return turns.some((t) => t.role === "kitty") ? "ask" : "parse";
}

/**
 * What to do with /parse's draft. A question goes to /ask, unless /ask already sent it here (one hop only):
 * then, like an unclear sentence, it gets 4a's "couldn't tell what you meant".
 */
export function afterParse(draft: PlainDraft, cameFromAsk: boolean): "card" | "ask" | "unclear" {
  if (draft.intent === "question") return cameFromAsk ? "unclear" : "ask";
  if (draft.intent === "unclear") return "unclear";
  return "card";
}
