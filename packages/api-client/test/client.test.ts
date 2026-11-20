import { describe, expect, test } from "vitest";
import { createGuestLedgerClient, createLedgerClient } from "../src/index";

function recordingFetch() {
  const requests: Request[] = [];
  const fetchFn = async (input: Request) => {
    requests.push(input);
    return new Response(JSON.stringify({ id: "00000000-0000-0000-0000-000000000001", displayName: "T", email: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { requests, fetchFn };
}

describe("createLedgerClient", () => {
  test("sends the bearer token on every request", async () => {
    const { requests, fetchFn } = recordingFetch();
    const client = createLedgerClient("http://ledger.test", async () => "tok-123", fetchFn);
    await client.GET("/me");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer tok-123");
  });

  test("adds an Idempotency-Key to mutations", async () => {
    const { requests, fetchFn } = recordingFetch();
    const client = createLedgerClient("http://ledger.test", async () => "tok", fetchFn);
    await client.PATCH("/me", { body: { displayName: "New" } });
    expect(requests[0]!.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("keeps a caller-supplied Idempotency-Key", async () => {
    const { requests, fetchFn } = recordingFetch();
    const client = createLedgerClient("http://ledger.test", async () => "tok", fetchFn);
    await client.PATCH("/me", { body: { displayName: "New" }, headers: { "Idempotency-Key": "form-key-1" } });
    expect(requests[0]!.headers.get("idempotency-key")).toBe("form-key-1");
  });

  test("a guest client sends the guest token, never a bearer token", async () => {
    const { requests, fetchFn } = recordingFetch();
    const guest = createGuestLedgerClient("http://ledger.test", "guest-tok", fetchFn);
    await guest.GET("/guest/table-sessions/{sessionId}", { params: { path: { sessionId: "00000000-0000-0000-0000-000000000001" } } });
    expect(requests[0]!.headers.get("authorization")).toBe("Guest guest-tok");
  });

  test("reads never get an Idempotency-Key", async () => {
    const { requests, fetchFn } = recordingFetch();
    const client = createLedgerClient("http://ledger.test", async () => "tok", fetchFn);
    await client.GET("/me");
    expect(requests[0]!.headers.has("idempotency-key")).toBe(false);
  });
});
