import type { Schemas } from "@kitty/api-client";
import { parseMoney, previewItemized } from "@kitty/money";
import { parsePercentToBasisPoints } from "./expense-form";

export type TableSession = Schemas["TableSessionDto"];

/** How a bill ended for someone who can no longer fetch it (a guest's access ends when it is confirmed or cancelled). */
export type Closed = { how: "confirmed" | "cancelled" | "unknown"; finalKnown: boolean };

export type TableState = {
  session: TableSession;
  /** Highest version a change event has announced; never below the version we hold. */
  wanted: number;
  /** The bill's status at that version, as far as we know. */
  lastStatus: string | null;
  /** Re-fetch regardless of versions: after a reconnect we may have missed events. */
  forced: boolean;
  /** Consecutive failed re-fetches, for backing off. */
  attempt: number;
  /** Set once this viewer can no longer read the bill. Terminal. */
  closed: Closed | null;
};

export type TableEvent =
  | { type: "changed"; version: number; status: string }
  | { type: "reconnected" }
  | { type: "loaded"; session: TableSession }
  /** The re-fetch says this viewer can no longer see the bill. */
  | { type: "gone" }
  /** The re-fetch itself failed (offline, server error): try again after a pause. */
  | { type: "failed" };

export function initialTableState(session: TableSession): TableState {
  return { session, wanted: session.version, lastStatus: session.status, forced: false, attempt: 0, closed: null };
}

/** True while the screen is behind the server (or might be) and should re-fetch. */
export function needsRefresh(state: TableState): boolean {
  return state.closed === null && (state.forced || state.wanted > state.session.version);
}

/**
 * Pure state logic behind useTableSession. Versions only move forward: older pushes and late responses are
 * ignored, every announced version is eventually fetched (even when several changes land at once), and a
 * reconnect always re-fetches because events may have been missed.
 */
export function tableReducer(state: TableState, event: TableEvent): TableState {
  if (state.closed) return state;

  switch (event.type) {
    case "changed":
      return event.version > state.wanted ? { ...state, wanted: event.version, lastStatus: event.status } : state;

    case "reconnected":
      return { ...state, forced: true };

    case "loaded": {
      if (event.session.version < state.session.version) return state;
      const caughtUp = event.session.version >= state.wanted;
      return {
        ...state,
        session: event.session,
        forced: false,
        attempt: 0,
        wanted: caughtUp ? event.session.version : state.wanted,
        lastStatus: caughtUp ? event.session.status : state.lastStatus,
      };
    }

    case "failed":
      return { ...state, attempt: state.attempt + 1 };

    case "gone": {
      const how = state.lastStatus === "confirmed" || state.lastStatus === "cancelled" ? state.lastStatus : "unknown";
      // The view we hold is the final split only if the confirmation was the very next change after it.
      const finalKnown = how === "confirmed" && state.wanted === state.session.version + 1;
      return { ...state, forced: false, closed: { how, finalKnown } };
    }
  }
}

/** Reconnect and retry pacing: 1s, 2s, 4s, 8s, then every 15s. It never gives up (phones sleep at the table). */
export function retryDelayMs(previousAttempts: number): number {
  return Math.min(1000 * 2 ** Math.min(previousAttempts, 10), 15_000);
}

/**
 * What the viewer owes, as the table should show it.
 * While the bill is open: only what they tapped, plus the tip on it. Items nobody has tapped are left out and
 * reported as `unclaimedMinor` (the server's preview would hand them all to whoever tapped first).
 * Once it is locked or confirmed: the server's split, which includes each person's part of unclaimed items.
 */
export function myShare(session: TableSession): { minor: number; unclaimedMinor: number; final: boolean } {
  const me = session.viewer.id;
  if (session.status !== "open")
    return { minor: session.preview.find((p) => p.id === me)?.amountMinor ?? 0, unclaimedMinor: 0, final: true };

  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const itemsTotal = sum(session.items.map((i) => i.lineTotalMinor));
  const chargesTotal = sum(session.charges.map((c) => c.amountMinor));
  const claimed = session.items.filter((i) => i.claimants.length > 0);
  const claimedTotal = sum(claimed.map((i) => i.lineTotalMinor));
  const participants = [...new Set(claimed.flatMap((i) => i.claimants.map((c) => c.id)))];
  // Extras (tip, service) follow the claimed items pro rata. If every item is free, the server shares them
  // equally between whoever tapped, so then they all belong to the people who tapped.
  const claimedCharges =
    itemsTotal === 0
      ? participants.length > 0 ? chargesTotal : 0
      : Number((BigInt(chargesTotal) * BigInt(claimedTotal)) / BigInt(itemsTotal));
  const unclaimedMinor = itemsTotal + chargesTotal - claimedTotal - claimedCharges;

  const shares =
    participants.length === 0
      ? []
      : previewItemized(
          claimed.map((i) => ({ itemId: i.id, lineTotalMinor: i.lineTotalMinor, claimerIds: i.claimants.map((c) => c.id) })),
          claimedCharges,
          participants,
        );
  const minor = Array.isArray(shares) ? (shares.find((s) => s.memberId === me)?.minor ?? 0) : 0;
  return { minor, unclaimedMinor, final: false };
}

/** Tip as typed: an amount ("25,50") or a percentage of the items ("10", "12.5"). Floors; null if invalid. */
export function tipToMinor(input: string, mode: "amount" | "percent", itemsTotalMinor: number, currency: string): number | null {
  if (input.trim() === "") return 0;
  if (mode === "amount") return parseMoney(input, currency);
  const bp = parsePercentToBasisPoints(input);
  return bp === null ? null : Number((BigInt(itemsTotalMinor) * BigInt(bp)) / 10_000n);
}
