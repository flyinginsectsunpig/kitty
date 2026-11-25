import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/auth/token", () => ({ getAccessToken: async () => "tok-1" }));

const { askKitty } = await import("@/lib/ai");

function respond(status: number, body: object) {
  const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchFn);
  return fetchFn;
}

describe("askKitty", () => {
  beforeEach(() => {
    process.env.AI_URL = "http://ai.test/";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_URL;
  });

  test("askKitty sends the messages and groupId with the token", async () => {
    const fetchFn = respond(200, { answer: "You owe R 120,00 in total." });
    const messages = [{ role: "person" as const, text: "How much do I owe?" }];

    expect(await askKitty(messages, "g-flat")).toEqual({ answer: "You owe R 120,00 in total." });

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("http://ai.test/ask");
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer tok-1");
    expect(JSON.parse(String(init!.body))).toEqual({ messages, groupId: "g-flat" });
  });

  test("askKitty turns an entry answer into entry", async () => {
    respond(200, { kind: "entry" });
    expect(await askKitty([{ role: "person", text: "petrol R600" }])).toEqual({ entry: true });
  });

  test("askKitty maps 429, 503 and 422 to codes", async () => {
    for (const [status, code] of [[429, "ai_rate_limited"], [503, "ai_unavailable"], [422, "unclear"]] as const) {
      respond(status, { code: "x" });
      expect(await askKitty([{ role: "person", text: "?" }])).toEqual({ error: code });
    }
  });

  test("askKitty without an ai service is unavailable", async () => {
    delete process.env.AI_URL;
    expect(await askKitty([{ role: "person", text: "?" }])).toEqual({ error: "ai_unavailable" });
  });
});
