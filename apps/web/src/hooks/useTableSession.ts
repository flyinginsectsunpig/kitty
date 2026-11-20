"use client";

import { HubConnectionBuilder, LogLevel } from "@microsoft/signalr";
import { useCallback, useEffect, useReducer } from "react";
import { keepLive, type LiveHub } from "@/lib/live-connection";
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
    const stopLive = keepLive({
      fetchToken: () => fetchListenToken(sessionId, groupId),
      createHub: (token) => signalRHub(hubUrl, token, sessionId),
      onChanged: (e) => dispatch({ type: "changed", version: e.version, status: e.status }),
      onResync: () => dispatch({ type: "reconnected" }),
      schedule: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    });

    const refreshWhenBack = () => {
      if (document.visibilityState === "visible") dispatch({ type: "reconnected" });
    };
    document.addEventListener("visibilitychange", refreshWhenBack);
    window.addEventListener("online", refreshWhenBack);

    return () => {
      stopLive();
      document.removeEventListener("visibilitychange", refreshWhenBack);
      window.removeEventListener("online", refreshWhenBack);
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

/** A SignalR connection to the table hub, opened with one bill's listen token. */
function signalRHub(hubUrl: string, token: string, sessionId: string): LiveHub {
  const connection = new HubConnectionBuilder()
    .withUrl(`${hubUrl}?listen_token=${encodeURIComponent(token)}`, { withCredentials: false })
    .withAutomaticReconnect({ nextRetryDelayInMilliseconds: (context) => retryDelayMs(context.previousRetryCount) })
    .configureLogging(LogLevel.Warning)
    .build();
  return {
    start: () => connection.start(),
    stop: () => connection.stop(),
    joinSession: () => connection.invoke("JoinSession", sessionId),
    onChanged: (cb) => connection.on("SessionChanged", cb),
    onReconnected: (cb) => connection.onreconnected(() => cb()),
    onClosed: (cb) => connection.onclose(() => cb()),
  };
}
