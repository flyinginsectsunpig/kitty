import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/auth/token", () => ({ getAccessToken: async () => "tok-1" }));

const { finishDraft, getDraft } = await import("@/lib/ai");

function respond(status: number, body: object | null) {
  const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchFn);
  return fetchFn;
}

describe("draft links", () => {
  beforeEach(() => {
    process.env.AI_URL = "http://ai.test/";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_URL;
  });

  test("getDraft fetches the card as the signed-in person", async () => {
    const card = { intent: "expense", groupId: "g-flat", issues: [], members: [] };
    const fetchFn = respond(200, card);

    expect(await getDraft("abcDEF123_-xyz7890")).toEqual({ draft: card });

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("http://ai.test/drafts/abcDEF123_-xyz7890");
    expect(init!.method ?? "GET").toBe("GET");
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer tok-1");
  });

  test("getDraft says the draft is gone on 404", async () => {
    respond(404, { code: "not_found" });
    expect(await getDraft("abcDEF123_-xyz7890")).toEqual({ error: "draft_gone" });
  });

  test("getDraft without the ai service is unavailable", async () => {
    delete process.env.AI_URL;
    expect(await getDraft("abcDEF123_-xyz7890")).toEqual({ error: "ai_unavailable" });
  });

  test("finishDraft deletes it with the token and ignores failures", async () => {
    const fetchFn = respond(204, null);
    await finishDraft("abcDEF123_-xyz7890");
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("http://ai.test/drafts/abcDEF123_-xyz7890");
    expect(init!.method).toBe("DELETE");
    expect(new Headers(init!.headers).get("authorization")).toBe("Bearer tok-1");

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    await expect(finishDraft("abcDEF123_-xyz7890")).resolves.toBeUndefined();
  });
});
