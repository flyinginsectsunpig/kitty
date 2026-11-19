"use client";

import { HubConnectionBuilder, LogLevel, type HubConnection } from "@microsoft/signalr";
import { useCallback, useEffect, useReducer } from "react";
import { fetchListenToken, fetchTableState } from "@/lib/table-client";
import { initialTableState, needsRefresh, retryDelayMs, tableReducer, type TableSession } from "@/lib/table-state";

/**
 * Keeps a table screen live. It listens on the ledger's hub with a read-only token for this one bill and
 * re-fetches whenever the server announces a change, after any reconnect, and when the phone wakes up or
 * comes back online (events may have been missed). Connecting and re-fetching both retry with back-off and
 * never give up while the bill is open. `closed` is set once this viewer can no longer see the bill.
 */
export function useTableSession(initial: TableSession, hubUrl: string, groupId: string | null) {
  const [state, dispatch] = useReducer(tableReducer, initial, initialTableState);
  const sessionId = initial.id;
  const closed = state.closed !== null;

  useEffect(() => {
    if (closed) return;
    let stopped = false;
    let connection: HubConnection | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = async (attempt: number) => {
      if (stopped) return;
      try {
        const token = await fetchListenToken(sessionId, groupId);
        if (stopped) return;
        if (!token) {
          // Nothing to listen to (access ended): one re-fetch settles whether the bill is closed.
          dispatch({ type: "reconnected" });
          return;
        }

        const next = new HubConnectionBuilder()
          .withUrl(`${hubUrl}?listen_token=${encodeURIComponent(token)}`, { withCredentials: false })
          .withAutomaticReconnect({ nextRetryDelayInMilliseconds: (context) => retryDelayMs(context.previousRetryCount) })
          .configureLogging(LogLevel.Warning)
          .build();
        connection = next;
        next.on("SessionChanged", (e: { version: number; status: string }) =>
          dispatch({ type: "changed", version: e.version, status: e.status }));
        next.onreconnected(() => {
          dispatch({ type: "reconnected" });
          void next.invoke("JoinSession", sessionId).catch(() => undefined);
        });

        await next.start();
        if (stopped) {
          void next.stop();
          return;
        }
        await next.invoke("JoinSession", sessionId);
        dispatch({ type: "reconnected" }); // pick up anything that changed between rendering the page and now
      } catch {
        void connection?.stop();
        connection = null;
        if (!stopped) retryTimer = setTimeout(() => void connect(attempt + 1), retryDelayMs(attempt));
      }
    };
    void connect(0);

    const refreshWhenBack = () => {
      if (document.visibilityState === "visible") dispatch({ type: "reconnected" });
    };
    document.addEventListener("visibilitychange", refreshWhenBack);
    window.addEventListener("online", refreshWhenBack);

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", refreshWhenBack);
      window.removeEventListener("online", refreshWhenBack);
      void connection?.stop();
    };
  }, [hubUrl, sessionId, groupId, closed]);

  const refreshNeeded = needsRefresh(state);
  const { attempt } = state;
  const heldVersion = state.session.version;
  useEffect(() => {
    if (!refreshNeeded) return;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        fetchTableState(sessionId, groupId).then(
          (session) => {
            if (!cancelled) dispatch(session ? { type: "loaded", session } : { type: "gone" });
          },
          () => {
            if (!cancelled) dispatch({ type: "failed" });
          },
        );
      },
      attempt === 0 ? 0 : retryDelayMs(attempt - 1),
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // heldVersion: after loading one version, run again if a newer one has already been announced.
  }, [refreshNeeded, heldVersion, attempt, sessionId, groupId]);

  /** Show the bill returned by the viewer's own action straight away. */
  const apply = useCallback((session: TableSession | null) => {
    if (session) dispatch({ type: "loaded", session });
  }, []);

  return { session: state.session, closed: state.closed, apply };
}
