import { useCallback } from "react";
import { useLedger } from "../ledger";

/** The ECB rate for a foreign currency on a date (YYYY-MM-DD), for the forms to show; null when it can't be fetched. */
export function useFetchRate(groupId: string) {
  const ledger = useLedger();
  return useCallback(
    async (currency: string, date: string): Promise<{ rate: string; rateDate: string } | null> => {
      const { data } = await ledger.GET("/groups/{groupId}/fx-rate", { params: { path: { groupId }, query: { currency, date } } });
      return data ? { rate: data.rate, rateDate: data.rateDate } : null;
    },
    [ledger, groupId],
  );
}
