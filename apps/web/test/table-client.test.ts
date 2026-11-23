import { describe, expect, test, vi } from "vitest";
import { isUuid } from "@kitty/core";
import { fetchListenToken, fetchTableState } from "@/lib/table-client";

const SESSION = "4d5ec024-10ed-40a7-bf95-c99363763e4c";
const GROUP = "433c23b9-42e1-4c29-9a57-d26e5805fe5c";

function respond(status: number, body: object = {}) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("fetchTableState", () => {
  test("returns the bill, asking as a group member when the group is known", async () => {
    const fetchFn = respond(200, { id: SESSION, version: 7 });
    expect(await fetchTableState(SESSION, GROUP, fetchFn)).toEqual({ id: SESSION, version: 7 });
    expect(String(fetchFn.mock.calls[0]![0])).toBe(`/t/${SESSION}/state?g=${GROUP}`);
    expect(fetchFn.mock.calls[0]![1]).toMatchObject({ cache: "no-store" });
  });

  test("asks without a group for guests", async () => {
    const fetchFn = respond(200, { id: SESSION, version: 1 });
    await fetchTableState(SESSION, null, fetchFn);
    expect(String(fetchFn.mock.calls[0]![0])).toBe(`/t/${SESSION}/state`);
  });

  test("404 means the viewer can no longer see the bill", async () =>
    expect(await fetchTableState(SESSION, null, respond(404))).toBeNull());

  test("any other failure throws, so the caller retries instead of closing the table", async () => {
    await expect(fetchTableState(SESSION, null, respond(500))).rejects.toThrow();
    await expect(fetchTableState(SESSION, null, vi.fn(async () => { throw new TypeError("offline"); }))).rejects.toThrow();
  });
});

describe("fetchListenToken", () => {
  test("returns the token", async () => {
    const fetchFn = respond(200, { token: "tok" });
    expect(await fetchListenToken(SESSION, GROUP, fetchFn)).toBe("tok");
    expect(String(fetchFn.mock.calls[0]![0])).toBe(`/t/${SESSION}/listen-token?g=${GROUP}`);
  });

  test("404 means there is nothing to listen to", async () =>
    expect(await fetchListenToken(SESSION, null, respond(404))).toBeNull());

  test("other failures throw", async () => {
    await expect(fetchListenToken(SESSION, null, respond(502))).rejects.toThrow();
  });
});

describe("isUuid", () => {
  test("accepts UUIDs in either case", () => {
    expect(isUuid(SESSION)).toBe(true);
    expect(isUuid(SESSION.toUpperCase())).toBe(true);
  });
  test.each(["", "not-a-uuid", `${SESSION}/../x`, `${SESSION} `, "4d5ec02410ed40a7bf95c99363763e4c"])("rejects %j", (value) =>
    expect(isUuid(value)).toBe(false));
  test("rejects non-strings", () => expect(isUuid(null)).toBe(false));
});
