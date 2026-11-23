import type { ExpenseWriteDto } from "@kitty/api-client";
import { CATEGORIES, splitProblemMessage, toExpenseWriteDto, type ExpenseFormState } from "@kitty/core";
import { formatMoney, parseMoney, previewSplit, type SplitMethod } from "@kitty/money";
import { useCallback, useMemo, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { useAction, type LedgerResult } from "../hooks/useAction";
import { colors, font, radius, space } from "../theme";
import { Button } from "./Button";
import { Checkbox } from "./Checkbox";
import { Chips } from "./Chips";
import { CurrencyPicker } from "./CurrencyPicker";
import { ErrorBanner } from "./ErrorBanner";
import { Card } from "./Screen";
import { TextField } from "./TextField";

type Member = { id: string; displayName: string };

const METHODS: { value: SplitMethod; label: string; hint: string }[] = [
  { value: "equal", label: "Equally", hint: "" },
  { value: "exact", label: "Amounts", hint: "amount" },
  { value: "percent", label: "Percent", hint: "%" },
  { value: "shares", label: "Shares", hint: "shares" },
];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const title = (c: string) => c[0]!.toUpperCase() + c.slice(1);

/**
 * The expense form (web's, natively). The same id and Idempotency-Key are kept until the save succeeds, so a retry
 * after a dropped connection can't create a second expense.
 */
export function ExpenseForm({ members, initial, submitLabel, save, onSaved }: {
  members: Member[];
  initial: ExpenseFormState;
  submitLabel: string;
  save: (dto: ExpenseWriteDto, idempotencyKey: string) => Promise<LedgerResult<unknown>>;
  onSaved: () => void;
}) {
  const [state, setState] = useState<ExpenseFormState>(initial);
  const dto = useMemo(() => toExpenseWriteDto(state), [state]);
  const nameOf = (id: string) => members.find((m) => m.id === id)?.displayName ?? "Someone";

  const preview = useMemo(() => {
    if ("error" in dto || dto.split.method === "itemized") return null;
    return previewSplit(dto.amountMinor, dto.split.method, dto.split.participants.map((p) => ({ memberId: p.memberId, value: p.value ?? null })));
  }, [dto]);

  const set = <K extends keyof ExpenseFormState>(key: K, value: ExpenseFormState[K]) => setState((s) => ({ ...s, [key]: value }));
  const setParticipant = (memberId: string, patch: Partial<ExpenseFormState["participants"][number]>) =>
    setState((s) => ({ ...s, participants: s.participants.map((p) => (p.memberId === memberId ? { ...p, ...patch } : p)) }));

  const amountMinor = parseMoney(state.amount, state.currency);
  const touched = state.amount !== "" || state.description !== "";
  const problem =
    "error" in dto
      ? dto.error
      : preview && "error" in preview
        ? splitProblemMessage(preview.error)
        : !state.description.trim()
          ? "Say what it was for."
          : !DATE.test(state.occurredOn)
            ? "Enter the date as YYYY-MM-DD."
            : null;

  const action = useAction(useCallback((key: string) => save(dto as ExpenseWriteDto, key), [save, dto]));

  async function onSubmit() {
    if (problem) return action.setError(problem);
    if ((await action.run()).ok) onSaved();
  }

  const method = METHODS.find((m) => m.value === state.method)!;
  return (
    <Card>
      <ErrorBanner message={action.error} />
      <TextField label="What was it for?" value={state.description} onChangeText={(v) => set("description", v)} maxLength={120} placeholder="Groceries, Uber, electricity…" />
      <TextField label="Amount" value={state.amount} onChangeText={(v) => set("amount", v)} keyboardType="decimal-pad" placeholder="0.00" />
      <CurrencyPicker label="Currency" value={state.currency} onChange={(v) => set("currency", v)} />
      <Chips label="Paid by" options={members.map((m) => m.id)} value={state.payerId} onChange={(v) => set("payerId", v)} render={nameOf} />
      <TextField label="Date" value={state.occurredOn} onChangeText={(v) => set("occurredOn", v)} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" />
      <Chips label="Category" options={CATEGORIES} value={state.category as (typeof CATEGORIES)[number]} onChange={(v) => set("category", v)} render={title} />
      <Chips label="Split" options={METHODS.map((m) => m.value)} value={state.method} onChange={(v) => set("method", v)} render={(v) => METHODS.find((m) => m.value === v)!.label} />
      <View style={styles.people}>
        {state.participants.map((p) => {
          const share = preview && !("error" in preview) ? preview.find((s) => s.memberId === p.memberId) : undefined;
          return (
            <View key={p.memberId} style={styles.person}>
              <Checkbox label={nameOf(p.memberId)} checked={p.included} onChange={(included) => setParticipant(p.memberId, { included })} />
              {state.method !== "equal" && p.included && (
                <TextInput
                  accessibilityLabel={`${nameOf(p.memberId)} ${method.hint}`}
                  keyboardType="decimal-pad"
                  placeholder={method.hint}
                  placeholderTextColor={colors.faint}
                  style={styles.value}
                  value={p.value}
                  onChangeText={(value) => setParticipant(p.memberId, { value })}
                />
              )}
              <Text style={styles.share}>{share ? formatMoney(share.minor, state.currency) : ""}</Text>
            </View>
          );
        })}
      </View>
      {touched && problem && !action.error && (
        <Text accessibilityLiveRegion="polite" style={styles.problem}>
          {problem}
        </Text>
      )}
      <Button
        title={`${submitLabel}${amountMinor ? ` · ${formatMoney(amountMinor, state.currency)}` : ""}`}
        busy={action.busy}
        onPress={() => void onSubmit()}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  people: { gap: space.xs },
  person: { flexDirection: "row", alignItems: "center", gap: space.sm },
  value: { width: 96, minHeight: 40, borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: radius.field, paddingHorizontal: space.sm, textAlign: "right", fontSize: font.base, color: colors.text, backgroundColor: colors.card },
  share: { width: 96, textAlign: "right", fontSize: font.sm, color: colors.muted },
  problem: { fontSize: font.sm, color: colors.owes },
});
