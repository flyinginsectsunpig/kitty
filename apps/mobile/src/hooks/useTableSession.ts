import { initialTableState, keepLive, needsRefresh, retryDelayMs, tableReducer, type LiveHub, type TableSession } from "@kitty/core";
import { HubConnectionBuilder, LogLevel } from "@microsoft/signalr";
import * as Network from "expo-network";
import { useCallback, useEffect, useReducer } from "react";
import { AppState } from "react-native";
import { config } from "../config";
import { useLedger } from "../ledger";

const TERMINAL = new Set(["confirmed", "cancelled"]);

/**
 * Keeps a table screen live, as web's hook does: it listens on the ledger's hub with a read-only token for this one
 * bill and re-fetches whenever the server announces a change, after a reconnect, when the app comes back to the
 * foreground and when the network returns (events may have been missed). Connecting and re-fetching retry with
 * back-off and never give up while the bill is open. Once the bill is confirmed or cancelled nothing more can change,
 * so it stops listening (battery).
 */
export function useTableSession(initial: TableSession, groupId: string) {
  const ledger = useLedger();
  const [state, dispatch] = useReducer(tableReducer, initial, initialTableState);
  const sessionId = initial.id;
  const ended = state.closed !== null || TERMINAL.has(state.session.status);

  const fetchState = useCallback(async (): Promise<TableSession | null> => {
    const r = await ledger.GET("/groups/{groupId}/table-sessions/{sessionId}", { params: { path: { groupId, sessionId } } });
    if (r.response.status === 404) return null;
    if (!r.data) throw new Error(`Table refresh failed (${r.response.status}).`);
    return r.data;
  }, [ledger, groupId, sessionId]);

  const fetchToken = useCallback(async (): Promise<string | null> => {
    const r = await ledger.GET("/groups/{groupId}/table-sessions/{sessionId}/listen-token", { params: { path: { groupId, sessionId } } });
    if (r.response.status === 404) return null;
    if (!r.data) throw new Error(`Listen token failed (${r.response.status}).`);
    return r.data.token;
  }, [ledger, groupId, sessionId]);

  useEffect(() => {
    if (ended) return;
    const resync = () => dispatch({ type: "reconnected" });
    const stopLive = keepLive({
      fetchToken,
      createHub: (token) => signalRHub(config.hubUrl, token, sessionId),
      onChanged: (e) => dispatch({ type: "changed", version: e.version, status: e.status }),
      onResync: resync,
      schedule: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    });
    const foreground = AppState.addEventListener("change", (s) => s === "active" && resync());
    const online = Network.addNetworkStateListener((s) => s.isConnected && resync());
    return () => {
      stopLive();
      foreground.remove();
      online.remove();
    };
  }, [ended, fetchToken, sessionId]);

  const refreshNeeded = needsRefresh(state);
  const { attempt } = state;
  const heldVersion = state.session.version;
  useEffect(() => {
    if (!refreshNeeded) return;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        fetchState().then(
          (session) => !cancelled && dispatch(session ? { type: "loaded", session } : { type: "gone" }),
          () => !cancelled && dispatch({ type: "failed" }),
        );
      },
      attempt === 0 ? 0 : retryDelayMs(attempt - 1),
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // heldVersion: after loading one version, run again if a newer one has already been announced.
  }, [refreshNeeded, heldVersion, attempt, fetchState]);

  /** Show the viewer's own change now: re-fetch (the claim endpoints return no bill). */
  const refresh = useCallback(() => dispatch({ type: "reconnected" }), []);
  const apply = useCallback((session: TableSession | null) => session && dispatch({ type: "loaded", session }), []);

  return { session: state.session, closed: state.closed, refresh, apply };
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
