import { errorMessage } from "@kitty/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { problemMessage, type LedgerResult } from "./useAction";

export type Loaded<T> = {
  data: T | null;
  /** Set when the last load failed (network or server). Shown with a "Try again". */
  error: string | null;
  /** The ledger said 404: no such thing, or this user can't see it. */
  notFound: boolean;
  loading: boolean;
  reload: () => Promise<void>;
};

/** Loads a screen's data when it mounts (and on `reload`). A thrown request is the "network" error. */
export function useLoad<T>(load: () => Promise<LedgerResult<T>>, deps: readonly unknown[]): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const live = useRef(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const loader = useCallback(load, deps);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await loader();
      if (!live.current) return;
      if (result.response.status === 404) {
        setNotFound(true);
      } else if (result.error !== undefined || result.data === undefined) {
        setError(problemMessage(result.error));
      } else {
        setNotFound(false);
        setData(result.data);
      }
    } catch {
      if (live.current) setError(errorMessage("network"));
    } finally {
      if (live.current) setLoading(false);
    }
  }, [loader]);

  useEffect(() => {
    live.current = true;
    void reload();
    return () => {
      live.current = false;
    };
  }, [reload]);

  return { data, error, notFound, loading, reload };
}
