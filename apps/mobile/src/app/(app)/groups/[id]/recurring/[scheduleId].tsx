import type { RecurringDto, RecurringWriteDto } from "@kitty/api-client";
import { errorMessage, isUuid, recurringForm } from "@kitty/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { Button } from "../../../../../components/Button";
import { ErrorBanner } from "../../../../../components/ErrorBanner";
import { ExpenseForm } from "../../../../../components/ExpenseForm";
import { LoadState, Screen } from "../../../../../components/Screen";
import { useGroup } from "../../../../../group/GroupContext";
import { useAction } from "../../../../../hooks/useAction";
import { useFetchRate } from "../../../../../hooks/useFetchRate";
import { useLoad } from "../../../../../hooks/useLoad";
import { useLedger } from "../../../../../ledger";
import { colors, font, space } from "../../../../../theme";

/** A repeating expense: edit it (as the expense form), pause or resume it, or stop it. */
export default function RecurringScreen() {
  const { scheduleId } = useLocalSearchParams<{ scheduleId: string }>();
  if (!isUuid(scheduleId))
    return (
      <Screen>
        <Text style={styles.muted}>{errorMessage("not_found")}</Text>
      </Screen>
    );
  return <Loaded scheduleId={scheduleId} />;
}

function Loaded({ scheduleId }: { scheduleId: string }) {
  const ledger = useLedger();
  const { group } = useGroup();
  const schedule = useLoad(
    () => ledger.GET("/groups/{groupId}/recurring/{scheduleId}", { params: { path: { groupId: group.id, scheduleId } } }),
    [ledger, group.id, scheduleId],
  );
  return (
    <Screen>
      <Stack.Screen options={{ title: "Repeating expense" }} />
      <LoadState state={schedule}>{(s) => <Editor key={`${s.id}:${s.version}`} schedule={s} reload={schedule.reload} />}</LoadState>
    </Screen>
  );
}

function Editor({ schedule: s, reload }: { schedule: RecurringDto; reload: () => Promise<void> | void }) {
  const ledger = useLedger();
  const router = useRouter();
  const { group, me } = useGroup();
  const fetchRate = useFetchRate(group.id);
  const path = { params: { path: { groupId: group.id, scheduleId: s.id } } };
  const { form, frequency, endsOn } = recurringForm(s, group.members.map((m) => m.id), me.id);
  const members = group.members.map((m) => ({ id: m.id, displayName: m.id === me.id ? "You" : m.displayName }));

  const saveRecurring = useCallback(
    (body: RecurringWriteDto, key: string) => ledger.PUT("/groups/{groupId}/recurring/{scheduleId}", { ...path, body, headers: { "Idempotency-Key": key } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ledger, group.id, s.id],
  );
  const toggle = useAction(
    useCallback(
      (key: string) =>
        s.paused
          ? ledger.POST("/groups/{groupId}/recurring/{scheduleId}/resume", { ...path, headers: { "Idempotency-Key": key } })
          : ledger.POST("/groups/{groupId}/recurring/{scheduleId}/pause", { ...path, headers: { "Idempotency-Key": key } }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [ledger, group.id, s.id, s.paused],
    ),
  );
  const stop = useAction(
    useCallback(
      (key: string) => ledger.DELETE("/groups/{groupId}/recurring/{scheduleId}", { ...path, headers: { "Idempotency-Key": key } }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [ledger, group.id, s.id],
    ),
  );
  const back = () => router.dismissTo(`/groups/${group.id}`);

  const confirmStop = () =>
    Alert.alert("Stop repeating?", `"${s.description}" won't be added again. Expenses already added stay.`, [
      { text: "Keep it", style: "cancel" },
      { text: "Stop", style: "destructive", onPress: () => void stop.run().then((r) => r.ok && back()) },
    ]);

  return (
    <View style={styles.wrap}>
      <Text style={styles.muted}>
        {s.paused ? "Paused: nothing is added until you resume it." : "Changes apply to the next ones; expenses already added stay as they are."}
      </Text>
      <ExpenseForm
        members={members}
        initial={form}
        submitLabel="Save changes"
        saveRecurring={saveRecurring}
        onSaved={back}
        groupCurrency={group.baseCurrency}
        fetchRate={fetchRate}
        repeat={{ initial: frequency, endsOn, dateLocked: s.lastAddedOn !== null, required: true }}
      />
      <ErrorBanner message={toggle.error ?? stop.error} />
      <Button
        title={s.paused ? "Resume" : "Pause"}
        variant="secondary"
        busy={toggle.busy}
        onPress={() => void toggle.run().then((r) => r.ok && reload())}
      />
      <Button title="Stop repeating" variant="danger" busy={stop.busy} onPress={confirmStop} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.md },
  muted: { fontSize: font.sm, color: colors.muted },
});
