import { retryDelayMs } from "./table-state";

/** The parts of a SignalR connection to the table hub that keepLive uses. */
export interface LiveHub {
  start(): Promise<void>;
  stop(): Promise<void>;
  joinSession(): Promise<void>;
  onChanged(cb: (e: { version: number; status: string }) => void): void;
  onReconnected(cb: () => void): void;
  onClosed(cb: () => void): void;
}

export type LiveDeps = {
  /** A fresh read-only token for this bill, or null when the viewer can no longer see it. */
  fetchToken: () => Promise<string | null>;
  createHub: (token: string) => LiveHub;
  onChanged: (e: { version: number; status: string }) => void;
  /** Events may have been missed: re-fetch the bill. */
  onResync: () => void;
  /** setTimeout, returning a cancel function. */
  schedule: (fn: () => void, ms: number) => () => void;
};

/**
 * Keeps one bill's live connection up until the returned function is called. A connection the server stops
 * accepting (it restarted and no longer knows the token) or that closes for good is thrown away and replaced
 * with one on a fresh token, with back-off, so the screen never goes quietly stale. Returns a stop function.
 */
export function keepLive(deps: LiveDeps): () => void {
  let stopped = false;
  let current: LiveHub | null = null;
  let failures = 0;
  let cancelRetry: (() => void) | null = null;

  const startOver = (hub: LiveHub) => {
    if (stopped || hub !== current) return; // already replaced, or closed by us
    current = null;
    void hub.stop().catch(() => undefined);
    cancelRetry = deps.schedule(() => {
      cancelRetry = null;
      void connect();
    }, retryDelayMs(failures++));
  };

  const connect = async () => {
    if (stopped) return;
    let hub: LiveHub | null = null;
    try {
      const token = await deps.fetchToken();
      if (stopped) return;
      if (!token) {
        deps.onResync(); // settles whether the bill is closed for this viewer
        return;
      }

      hub = deps.createHub(token);
      current = hub;
      const self = hub;
      hub.onChanged(deps.onChanged);
      hub.onReconnected(() => {
        deps.onResync();
        self.joinSession().catch(() => startOver(self));
      });
      hub.onClosed(() => startOver(self));

      await hub.start();
      if (stopped) return;
      await hub.joinSession();
      failures = 0;
      deps.onResync(); // pick up anything that changed before the connection was up
    } catch {
      if (hub) startOver(hub);
      else if (!stopped) cancelRetry = deps.schedule(() => void connect(), retryDelayMs(failures++));
    }
  };
  void connect();

  return () => {
    stopped = true;
    cancelRetry?.();
    const hub = current;
    current = null;
    void hub?.stop().catch(() => undefined);
  };
}
