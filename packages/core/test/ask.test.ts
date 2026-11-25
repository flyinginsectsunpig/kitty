import { describe, expect, test } from "vitest";
import { afterParse, askMessages, MAX_ASK_MESSAGES, MAX_KITTY_TEXT, routeFirst, type Turn } from "../src/ask";
import type { PlainDraft } from "../src/plain-entry";

function draft(intent: PlainDraft["intent"]): PlainDraft {
  return { intent, groupId: "g-flat", issues: [], members: [], groups: [{ id: "g-flat", name: "Flat 4B" }], parsed: {} };
}

describe("Ask Kitty conversation", () => {
  test("first message goes to parse, later ones to ask", () => {
    expect(routeFirst([])).toBe("parse");
    expect(routeFirst([{ role: "person", text: "how much do I owe?" }, { role: "kitty", text: "R 120,00" }])).toBe("ask");
    expect(routeFirst([{ role: "draft", draft: draft("expense") }])).toBe("ask");
  });

  test("askMessages drops drafts and errors and keeps the last 12", () => {
    const turns: Turn[] = [{ role: "draft", draft: draft("expense") }, { role: "error", code: "rate_limited" }];
    for (let i = 0; i < 13; i++) turns.push({ role: i % 2 === 0 ? "person" : "kitty", text: `m${i}` });
    turns.push({ role: "error", code: "ai_unavailable" });
    turns.push({ role: "person", text: "last" });

    const sent = askMessages(turns);

    expect(sent).toHaveLength(MAX_ASK_MESSAGES);
    expect(sent.at(-1)).toEqual({ role: "person", text: "last" });
    expect(sent[0]).toEqual({ role: "person", text: "m2" });
    expect(sent.every((m) => m.role === "person" || m.role === "kitty")).toBe(true);
  });

  test("askMessages cuts long Kitty text", () => {
    const sent = askMessages([
      { role: "person", text: "everything?" },
      { role: "kitty", text: "x".repeat(MAX_KITTY_TEXT + 50) },
      { role: "person", text: "and Joe?" },
    ]);
    expect(sent[1]?.text).toHaveLength(MAX_KITTY_TEXT);
  });

  test("askMessages trims the person's text", () => {
    expect(askMessages([{ role: "person", text: "  how much?  " }])).toEqual([{ role: "person", text: "how much?" }]);
  });

  test("a question from parse goes to ask", () => {
    expect(afterParse(draft("question"), false)).toBe("ask");
  });

  test("a question that came back from ask is unclear", () => {
    expect(afterParse(draft("question"), true)).toBe("unclear");
    expect(afterParse(draft("unclear"), true)).toBe("unclear");
    expect(afterParse(draft("unclear"), false)).toBe("unclear");
  });

  test("an expense draft is a card", () => {
    expect(afterParse(draft("expense"), true)).toBe("card");
    expect(afterParse(draft("reminder"), false)).toBe("card");
  });
});
