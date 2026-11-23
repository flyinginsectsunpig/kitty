import type { LedgerProblem } from "@kitty/api-client";
import { errorMessage } from "@kitty/core";
import { randomUUID } from "expo-crypto";
import { useCallback, useRef, useState } from "react";

export type LedgerResult<T> = { data?: T; error?: unknown; response: Response };
export type ActionOutcome<T> = { ok: true; data: T | undefined } | { ok: false };

/** The message for a failed ledger call: its problem code's text, or a generic line. */
export function problemMessage(error: unknown): string {
  return errorMessage((error as LedgerProblem | undefined)?.code ?? "unexpected")!;
}

/**
 * Runs one screen action (a mutation). It never throws and never leaves `busy` stuck: a request that throws (no
 * signal, server restarting) becomes the "network" message. The Idempotency-Key stays the same until the ledger has
 * answered, so a retry after a dropped connection, or a double tap, replays the first request instead of repeating it.
 */
export function useAction<T>(fn: (idempotencyKey: string) => Promise<LedgerResult<T>>) {
  const key = useRef(randomUUID());
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (): Promise<ActionOutcome<T>> => {
    if (running.current) return { ok: false }; // a double tap while the first is in flight
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await fn(key.current);
      if (result.error !== undefined || !result.response.ok) {
        // The ledger stores every answer below 500 under its key, so a retry with that key would replay this error
        // even after the form is fixed: take a new key. Keep it only while the first request is still running.
        const code = (result.error as LedgerProblem | undefined)?.code;
        if (result.response.status < 500 && code !== "request_in_progress") key.current = randomUUID();
        setError(problemMessage(result.error));
        return { ok: false };
      }
      key.current = randomUUID();
      return { ok: true, data: result.data };
    } catch {
      setError(errorMessage("network"));
      return { ok: false };
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [fn]);

  const reset = useCallback(() => setError(null), []);
  return { run, busy, error, setError, reset };
}
