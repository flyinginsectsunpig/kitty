import { useFocusEffect } from "expo-router";
import { useCallback, useRef } from "react";

/** Reloads when the user comes back to this screen (after adding or editing something). The first focus is skipped:
 * that's the screen's own first load. */
export function useReloadOnReturn(reload: () => Promise<void>) {
  const focusedBefore = useRef(false);
  const latest = useRef(reload);
  latest.current = reload;
  useFocusEffect(
    useCallback(() => {
      if (focusedBefore.current) void latest.current();
      focusedBefore.current = true;
    }, []),
  );
}
