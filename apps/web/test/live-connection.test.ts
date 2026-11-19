import { describe, expect, test, vi } from "vitest";
import { keepLive, type LiveHub } from "@/lib/live-connection";

/** A hub the test drives by hand: it records calls and lets the test fire the connection's events. */
class FakeHub implements LiveHub {
  started = false;
  stopped = false;
  joinResult: Promise<void> = Promise.resolve();
  failStart = false;
  private changed?: (e: { version: number; status: string }) => void;
  private reconnected?: () => void;
  private closed?: () => void;

  constructor(readonly token: string) {}
  start = vi.fn(async () => {
    if (this.failStart) throw new Error("unreachable");
    this.started = true;
  });
  stop = vi.fn(async () => {
    this.stopped = true;
    this.closed?.(); // SignalR reports its own stop as a close too
  });
  joinSession = vi.fn(() => this.joinResult);
  onChanged(cb: (e: { version: number; status: string }) => void) {
    this.changed = cb;
  }
  onReconnected(cb: () => void) {
    this.reconnected = cb;
  }
  onClosed(cb: () => void) {
    this.closed = cb;
  }
  fireChanged(version: number, status = "open") {
    this.changed?.({ version, status });
  }
  fireReconnected() {
    this.reconnected?.();
  }
  fireClosed() {
    this.closed?.();
  }
}

function setup(tokens: (string | null)[] = ["t1", "t2", "t3"], failStarts = 0) {
  const hubs: FakeHub[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const changed = vi.fn();
  const resync = vi.fn();
  let next = 0;
  const stop = keepLive({
    fetchToken: vi.fn(async () => tokens[next++] ?? null),
    createHub: (token) => {
      const hub = new FakeHub(token);
      hub.failStart = hubs.length < failStarts;
      hubs.push(hub);
      return hub;
    },
    onChanged: changed,
    onResync: resync,
    schedule: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const runTimers = async () => {
    for (const t of timers.splice(0)) t.fn();
    await settle();
  };
  return { hubs, timers, changed, resync, stop, settle, runTimers };
}

describe("keepLive", () => {
  test("connects with a listen token, joins the bill and re-fetches once", async () => {
    const { hubs, resync, settle } = setup();
    await settle();
    expect(hubs).toHaveLength(1);
    expect(hubs[0]!.token).toBe("t1");
    expect(hubs[0]!.joinSession).toHaveBeenCalledOnce();
    expect(resync).toHaveBeenCalledOnce();
  });

  test("passes change announcements on", async () => {
    const { hubs, changed, settle } = setup();
    await settle();
    hubs[0]!.fireChanged(7, "locked");
    expect(changed).toHaveBeenCalledWith({ version: 7, status: "locked" });
  });

  test("re-fetches after an automatic reconnect that the server accepts", async () => {
    const { hubs, resync, settle } = setup();
    await settle();
    hubs[0]!.fireReconnected();
    await settle();
    expect(resync).toHaveBeenCalledTimes(2);
    expect(hubs).toHaveLength(1);
  });

  test("starts over with a fresh token when the server rejects the old one after a reconnect", async () => {
    // e.g. the ledger restarted and no longer accepts the token the connection was opened with
    const { hubs, timers, settle, runTimers } = setup();
    await settle();
    hubs[0]!.joinResult = Promise.reject(new Error("not allowed"));
    hubs[0]!.fireReconnected();
    await settle();

    expect(hubs[0]!.stopped).toBe(true);
    expect(timers).toHaveLength(1);
    await runTimers();
    expect(hubs).toHaveLength(2);
    expect(hubs[1]!.token).toBe("t2");
    expect(hubs[1]!.joinSession).toHaveBeenCalledOnce();
  });

  test("starts over with a fresh token when the connection closes for good", async () => {
    const { hubs, timers, settle, runTimers } = setup();
    await settle();
    hubs[0]!.fireClosed();
    expect(timers).toHaveLength(1);
    await runTimers();
    expect(hubs).toHaveLength(2);
    expect(hubs[1]!.token).toBe("t2");
  });

  test("backs off while connecting keeps failing, and resets once connected", async () => {
    const { hubs, timers, settle, runTimers } = setup(["t1", "t2", "t3", "t4"], 2);
    await settle();
    expect(timers.map((t) => t.ms)).toEqual([1000]);
    await runTimers();
    expect(timers.map((t) => t.ms)).toEqual([2000]);
    await runTimers();
    expect(hubs[2]!.started).toBe(true);

    hubs[2]!.fireClosed();
    expect(timers.map((t) => t.ms)).toEqual([1000]);
  });

  test("with no listen token (access ended) it re-fetches once and stops trying", async () => {
    const { hubs, timers, resync, settle } = setup([null]);
    await settle();
    expect(hubs).toHaveLength(0);
    expect(timers).toHaveLength(0);
    expect(resync).toHaveBeenCalledOnce();
  });

  test("stopping closes the connection without starting over", async () => {
    const { hubs, timers, stop, settle } = setup();
    await settle();
    stop();
    await settle();
    expect(hubs[0]!.stopped).toBe(true);
    expect(timers).toHaveLength(0);
  });
});
