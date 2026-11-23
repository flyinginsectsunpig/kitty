import type { ExpenseDto, ExpenseWriteDto } from "@kitty/api-client";
import { editExpenseForm, errorMessage, isUuid } from "@kitty/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback } from "react";
import { Alert, StyleSheet, Text } from "react-native";
import { Button } from "../../../../../components/Button";
import { ErrorBanner } from "../../../../../components/ErrorBanner";
import { ExpenseForm } from "../../../../../components/ExpenseForm";
import { Card, LoadState, Screen } from "../../../../../components/Screen";
import { useGroup } from "../../../../../group/GroupContext";
import { useAction } from "../../../../../hooks/useAction";
import { useLoad } from "../../../../../hooks/useLoad";
import { useLedger } from "../../../../../ledger";
import { colors, font } from "../../../../../theme";

export default function EditExpenseScreen() {
  const { expenseId } = useLocalSearchParams<{ expenseId: string }>();
  if (!isUuid(expenseId))
    return (
      <Screen>
        <Text style={styles.muted}>{errorMessage("not_found")}</Text>
      </Screen>
    );
  return <Loaded expenseId={expenseId} />;
}

function Loaded({ expenseId }: { expenseId: string }) {
  const ledger = useLedger();
  const { group } = useGroup();
  const path = { params: { path: { groupId: group.id, expenseId } } };
  const expense = useLoad(() => ledger.GET("/groups/{groupId}/expenses/{expenseId}", path), [ledger, group.id, expenseId]);

  return (
    <Screen>
      <Stack.Screen options={{ title: "Edit expense" }} />
      <LoadState state={expense}>{(e) => <Editor expense={e} />}</LoadState>
    </Screen>
  );
}

function Editor({ expense }: { expense: ExpenseDto }) {
  const ledger = useLedger();
  const router = useRouter();
  const { group, me } = useGroup();
  const back = () => router.dismissTo(`/groups/${group.id}`);
  const path = { params: { path: { groupId: group.id, expenseId: expense.id } } };

  const save = useCallback(
    (body: ExpenseWriteDto, key: string) => ledger.PUT("/groups/{groupId}/expenses/{expenseId}", { ...path, body, headers: { "Idempotency-Key": key } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ledger, group.id, expense.id],
  );
  const remove = useAction(
    useCallback(
      (key: string) => ledger.DELETE("/groups/{groupId}/expenses/{expenseId}", { ...path, headers: { "Idempotency-Key": key } }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [ledger, group.id, expense.id],
    ),
  );

  const confirmDelete = () =>
    Alert.alert("Delete this expense?", `"${expense.description}" will be removed from everyone's balances.`, [
      { text: "Keep it", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void remove.run().then((r) => r.ok && back()) },
    ]);

  const deleteButton = (
    <>
      <ErrorBanner message={remove.error} />
      <Button title="Delete expense" variant="danger" busy={remove.busy} onPress={confirmDelete} />
    </>
  );

  if (expense.split.method === "itemized")
    return (
      <>
        <Card>
          <Text style={styles.title}>{expense.description}</Text>
          <Text style={styles.muted}>
            This bill was split item by item at the table, so it can't be edited here. To change it, delete it and split the bill again.
          </Text>
        </Card>
        {deleteButton}
      </>
    );

  return (
    <>
      <ExpenseForm
        members={group.members.map((m) => ({ id: m.id, displayName: m.id === me.id ? "You" : m.displayName }))}
        initial={editExpenseForm(expense, group.members.map((m) => m.id), me.id)}
        submitLabel="Save changes"
        save={save}
        onSaved={back}
      />
      {deleteButton}
    </>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: font.lg, fontWeight: "600", color: colors.text },
  muted: { fontSize: font.sm, color: colors.muted },
});
