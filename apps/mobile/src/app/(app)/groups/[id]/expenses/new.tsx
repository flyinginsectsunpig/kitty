import type { ExpenseWriteDto, RecurringWriteDto } from "@kitty/api-client";
import { newExpenseForm } from "@kitty/core";
import { randomUUID } from "expo-crypto";
import { Stack, useRouter } from "expo-router";
import { useCallback, useMemo } from "react";
import { ExpenseForm } from "../../../../../components/ExpenseForm";
import { Screen } from "../../../../../components/Screen";
import { useGroup } from "../../../../../group/GroupContext";
import { useFetchRate } from "../../../../../hooks/useFetchRate";
import { useLedger } from "../../../../../ledger";

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export default function NewExpenseScreen() {
  const ledger = useLedger();
  const router = useRouter();
  const { group, me } = useGroup();
  const initial = useMemo(
    () => newExpenseForm({ id: randomUUID(), today: today(), currency: group.baseCurrency, meId: me.id, memberIds: group.members.map((m) => m.id) }),
    [group, me.id],
  );
  const members = group.members.map((m) => ({ id: m.id, displayName: m.id === me.id ? "You" : m.displayName }));
  const save = useCallback(
    (body: ExpenseWriteDto, key: string) =>
      ledger.POST("/groups/{groupId}/expenses", { params: { path: { groupId: group.id } }, body, headers: { "Idempotency-Key": key } }),
    [ledger, group.id],
  );

  const fetchRate = useFetchRate(group.id);
  const saveRecurring = useCallback(
    (body: RecurringWriteDto, key: string) =>
      ledger.POST("/groups/{groupId}/recurring", { params: { path: { groupId: group.id } }, body, headers: { "Idempotency-Key": key } }),
    [ledger, group.id],
  );

  return (
    <Screen>
      <Stack.Screen options={{ title: "Add an expense" }} />
      <ExpenseForm members={members} initial={initial} submitLabel="Save expense" save={save} onSaved={() => router.dismissTo(`/groups/${group.id}`)}
        groupCurrency={group.baseCurrency} fetchRate={fetchRate} saveRecurring={saveRecurring} repeat={{ initial: "none", endsOn: "" }} />
    </Screen>
  );
}
