import { describe, expect, test } from "vitest";
import {
  initialTableState,
  myShare,
  needsRefresh,
  retryDelayMs,
  tableReducer,
  tipToMinor,
  type TableEvent,
  type TableSession,
  type TableState,
} from "@/lib/table-state";

const bill = (version: number, extra: object = {}) =>
  ({
    id: "s1",
    version,
    status: "open",
    currency: "ZAR",
    viewer: { kind: "member", id: "me" },
    items: [],
    charges: [],
    guests: [],
    preview: [],
    ...extra,
  }) as unknown as TableSession;

const changed = (version: number, status = "open"): TableEvent => ({ type: "changed", version, status });
const run = (state: TableState, ...events: TableEvent[]) => events.reduce(tableReducer, state);
const start = (version = 5) => initialTableState(bill(version));

describe("tableReducer: keeping up with the table", () => {
  test("a newer version needs a re-fetch", () => expect(needsRefresh(run(start(), changed(6)))).toBe(true));

  test("an event for a version we already have is ignored", () => {
    const state = start();
    expect(tableReducer(state, changed(5))).toBe(state);
    expect(tableReducer(state, changed(3))).toBe(state);
  });

  test("reconnect triggers refetch even with no newer version", () =>
    expect(needsRefresh(run(start(), { type: "reconnected" }))).toBe(true));

  test("a loaded session replaces the view and settles", () => {
    const next = run(start(), changed(6), { type: "loaded", session: bill(6) });
    expect(next.session.version).toBe(6);
    expect(needsRefresh(next)).toBe(false);
  });

  test("two quick changes: loading the first still leaves the second to fetch", () => {
    const afterFirstLoad = run(start(), changed(6), changed(7), { type: "loaded", session: bill(6) });
    expect(needsRefresh(afterFirstLoad)).toBe(true);
    expect(needsRefresh(run(afterFirstLoad, { type: "loaded", session: bill(7) }))).toBe(false);
  });

  test("an older response arriving late never rolls the view back", () => {
    const state = initialTableState(bill(9));
    expect(tableReducer(state, { type: "loaded", session: bill(8) })).toBe(state);
  });

  test("a failed re-fetch is retried, and a successful load resets the attempts", () => {
    const failedTwice = run(start(), changed(6), { type: "failed" }, { type: "failed" });
    expect(failedTwice.attempt).toBe(2);
    expect(needsRefresh(failedTwice)).toBe(true);
    expect(run(failedTwice, { type: "loaded", session: bill(6) }).attempt).toBe(0);
  });
});

describe("tableReducer: when a guest's access ends", () => {
  test("after a confirm event the table closes as confirmed, and the last view is final", () => {
    const state = run(start(), changed(6, "confirmed"), { type: "gone" });
    expect(state.closed).toEqual({ how: "confirmed", finalKnown: true });
    expect(needsRefresh(state)).toBe(false);
  });

  test("if we were behind when it was confirmed, the last view is not claimed to be final", () => {
    const state = run(start(), changed(6), changed(7, "confirmed"), { type: "gone" });
    expect(state.closed).toEqual({ how: "confirmed", finalKnown: false });
  });

  test("a cancelled bill closes as cancelled", () =>
    expect(run(start(), changed(6, "cancelled"), { type: "gone" }).closed).toEqual({ how: "cancelled", finalKnown: false }));

  test("losing access with no event to explain it is an unknown closure", () =>
    expect(run(start(), { type: "reconnected" }, { type: "gone" }).closed).toEqual({ how: "unknown", finalKnown: false }));

  test("a closed table ignores everything afterwards", () => {
    const closed = run(start(), changed(6, "confirmed"), { type: "gone" });
    expect(tableReducer(closed, changed(7))).toBe(closed);
    expect(tableReducer(closed, { type: "reconnected" })).toBe(closed);
  });
});

describe("retryDelayMs", () => {
  test("backs off from one second", () => expect([0, 1, 2, 3].map(retryDelayMs)).toEqual([1000, 2000, 4000, 8000]));
  test("is capped and never gives up", () => {
    expect(retryDelayMs(4)).toBe(15000);
    expect(retryDelayMs(500)).toBe(15000);
  });
});

describe("myShare", () => {
  const me = { kind: "member", id: "me", displayName: "Me" };
  const sam = { kind: "member", id: "sam", displayName: "Sam" };
  const item = (id: string, lineTotalMinor: number, claimants: object[]) => ({ id, description: id, quantity: 1, lineTotalMinor, claimants });

  test("while open, counts only what I tapped plus the tip on it", () => {
    const session = bill(1, {
      items: [item("cokes", 8000, [me]), item("pizza", 12000, [])],
      charges: [{ id: "tip", kind: "tip", amountMinor: 2000 }],
      // The server's "if confirmed now" preview would give me the whole bill:
      preview: [{ kind: "member", id: "me", displayName: "Me", amountMinor: 22000 }],
    });
    expect(myShare(session)).toEqual({ minor: 8800, unclaimedMinor: 13200, final: false });
  });

  test("a shared item is split between the people who tapped it", () => {
    const session = bill(1, { items: [item("bread", 6000, [me, sam])] });
    expect(myShare(session)).toEqual({ minor: 3000, unclaimedMinor: 0, final: false });
  });

  test("nothing tapped yet is zero, with everything still unclaimed", () => {
    const session = bill(1, { items: [item("pizza", 12000, [])], charges: [{ id: "tip", kind: "tip", amountMinor: 1200 }] });
    expect(myShare(session)).toEqual({ minor: 0, unclaimedMinor: 13200, final: false });
  });

  test("once the bill is locked, the server's split is the answer", () => {
    const session = bill(1, {
      status: "locked",
      items: [item("cokes", 8000, [me]), item("pizza", 12000, [])],
      preview: [{ kind: "member", id: "me", displayName: "Me", amountMinor: 20000 }],
    });
    expect(myShare(session)).toEqual({ minor: 20000, unclaimedMinor: 0, final: true });
  });

  test("someone who claimed nothing owes nothing on a locked bill", () => {
    const session = bill(1, { status: "locked", items: [item("cokes", 8000, [sam])], preview: [{ kind: "member", id: "sam", displayName: "Sam", amountMinor: 8000 }] });
    expect(myShare(session)).toEqual({ minor: 0, unclaimedMinor: 0, final: true });
  });
});

describe("tipToMinor", () => {
  test("an amount is parsed as money", () => expect(tipToMinor("25,50", "amount", 30000, "ZAR")).toBe(2550));
  test("a percentage of the items total, floored", () => expect(tipToMinor("10", "percent", 23050, "ZAR")).toBe(2305));
  test("fractional percentages work", () => expect(tipToMinor("12.5", "percent", 10000, "ZAR")).toBe(1250));
  test("empty means no tip", () => expect(tipToMinor("", "percent", 10000, "ZAR")).toBe(0));
  test("garbage is rejected", () => {
    expect(tipToMinor("lots", "amount", 10000, "ZAR")).toBeNull();
    expect(tipToMinor("150", "percent", 10000, "ZAR")).toBeNull();
  });
});
