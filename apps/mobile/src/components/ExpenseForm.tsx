import type { ExpenseWriteDto, RecurringWriteDto } from "@kitty/api-client";
import {
  CATEGORIES,
  describeRate,
  describeRule,
  splitProblemMessage,
  toExpenseWriteDto,
  toRecurringWriteDto,
  type ExpenseFormState,
  type Repeat,
} from "@kitty/core";
import { convertMinor, formatMoney, parseMoney, parseRate, previewSplit, type SplitMethod } from "@kitty/money";
import { useCallback, useEffect, useMemo, useState } from "react";
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

/** The rate a saved expense already has (edit only). */
export type SavedRate = { currency: string; occurredOn: string; fxRate?: string | null; fxRateDate?: string | null; fxRateSource?: string | null };

export type FetchRate = (currency: string, date: string) => Promise<{ rate: string; rateDate: string } | null>;

type Quote = { rate: string; rateDate: string } | "failed" | null;

/** Offer "Repeat" (new expenses and schedules). `required`: editing a schedule, which can't stop repeating here. */
export type RepeatOptions = { initial: Repeat; endsOn: string; dateLocked?: boolean; required?: boolean };

const REPEAT_LABELS: Record<Repeat, string> = { none: "Doesn't repeat", weekly: "Every week", monthly: "Every month" };

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
export function ExpenseForm({ members, initial, submitLabel, save, saveRecurring, onSaved, groupCurrency, fetchRate, saved, repeat: repeatOptions }: {
  members: Member[];
  initial: ExpenseFormState;
  submitLabel: string;
  /** Saves a one-off expense (absent when editing a schedule, which always repeats). */
  save?: (dto: ExpenseWriteDto, idempotencyKey: string) => Promise<LedgerResult<unknown>>;
  /** Saves it as a repeating schedule instead (when Repeat is set). */
  saveRecurring?: (dto: RecurringWriteDto, idempotencyKey: string) => Promise<LedgerResult<unknown>>;
  onSaved: () => void;
  groupCurrency: string;
  fetchRate: FetchRate;
  saved?: SavedRate;
  repeat?: RepeatOptions;
}) {
  const [state, setState] = useState<ExpenseFormState>(initial);
  const [repeat, setRepeat] = useState<Repeat>(repeatOptions?.initial ?? "none");
  const [endsOn, setEndsOn] = useState(repeatOptions?.endsOn ?? "");
  const [quote, setQuote] = useState<Quote>(null);
  const foreign = state.currency !== groupCurrency;
  // An unchanged currency and date keep the saved rate (the ledger does the same); anything else shows the ECB rate.
  const keepsSaved = !!saved?.fxRate && saved.currency === state.currency && saved.occurredOn === state.occurredOn;

  useEffect(() => {
    if (!foreign || keepsSaved || !DATE.test(state.occurredOn)) {
      setQuote(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      fetchRate(state.currency, state.occurredOn)
        .then((q) => live && setQuote(q ?? "failed"))
        .catch(() => live && setQuote("failed"));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [foreign, keepsSaved, state.currency, state.occurredOn, fetchRate]);
  const dto = useMemo(
    () => (repeat === "none" ? toExpenseWriteDto(state) : toRecurringWriteDto(state, repeat, endsOn)),
    [state, repeat, endsOn],
  );
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

  const action = useAction(
    useCallback(
      (key: string) => (repeat === "none" ? save!(dto as ExpenseWriteDto, key) : saveRecurring!(dto as RecurringWriteDto, key)),
      [save, saveRecurring, dto, repeat],
    ),
  );

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
      <CurrencyPicker label="Currency" value={state.currency} onChange={(v) => setState((s) => ({ ...s, currency: v, fxRate: "" }))} />
      <Chips label="Paid by" options={members.map((m) => m.id)} value={state.payerId} onChange={(v) => set("payerId", v)} render={nameOf} />
      <TextField label="Date" value={state.occurredOn} onChangeText={(v) => setState((s) => ({ ...s, occurredOn: v, fxRate: "" }))} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation"
        editable={!repeatOptions?.dateLocked} />
      {repeatOptions?.dateLocked && <Text style={styles.note}>It has already added expenses, so the start date stays.</Text>}
      {repeatOptions && (
        <>
          <Chips label="Repeat" options={repeatOptions.required ? (["weekly", "monthly"] as const) : (["none", "weekly", "monthly"] as const)}
            value={repeat} onChange={setRepeat} render={(r) => REPEAT_LABELS[r]} />
          {repeat !== "none" && DATE.test(state.occurredOn) && (
            <Text style={styles.note}>
              {describeRule(repeat, state.occurredOn)}, starting {state.occurredOn}. Each one is added automatically on its day.
            </Text>
          )}
          {repeat !== "none" && (
            <TextField label="Ends (optional)" value={endsOn} onChangeText={setEndsOn} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" />
          )}
        </>
      )}
      {foreign && repeat === "none" && (
        <RatePanel state={state} groupCurrency={groupCurrency} quote={quote} saved={keepsSaved ? saved : undefined}
          amountMinor={amountMinor} onRate={(v) => set("fxRate", v)} />
      )}
      {foreign && repeat !== "none" && <Text style={styles.note}>Each time it repeats, it uses that day's ECB exchange rate.</Text>}
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

/** The exchange rate for a foreign-currency expense: the saved or ECB rate, the converted amount, and an edit box. */
function RatePanel({ state, groupCurrency, quote, saved, amountMinor, onRate }: {
  state: ExpenseFormState;
  groupCurrency: string;
  quote: Quote;
  saved: SavedRate | undefined;
  amountMinor: number | null;
  onRate: (value: string) => void;
}) {
  const shown = saved?.fxRate
    ? { rate: saved.fxRate, rateDate: saved.fxRateDate ?? null, source: saved.fxRateSource ?? "ecb" }
    : quote && quote !== "failed" ? { rate: quote.rate, rateDate: quote.rateDate, source: "ecb" } : null;
  const rate = parseRate(state.fxRate.trim()) ?? shown?.rate ?? null;
  return (
    <View style={styles.rate}>
      <Text style={styles.rateText}>
        {shown ? describeRate({ from: state.currency, to: groupCurrency, ...shown })
          : quote === "failed" ? "Couldn't get the ECB rate. Type it below, or save and add it later."
          : "Getting the ECB rate…"}
      </Text>
      {rate && amountMinor ? (
        <Text style={styles.converted}>≈ {formatMoney(convertMinor(amountMinor, rate, state.currency, groupCurrency), groupCurrency)}</Text>
      ) : null}
      <TextField label={`Edit rate (1 ${state.currency} in ${groupCurrency})`} value={state.fxRate} onChangeText={onRate}
        keyboardType="decimal-pad" placeholder={shown?.rate ?? "e.g. 19.5"} />
    </View>
  );
}

const styles = StyleSheet.create({
  note: { fontSize: font.sm, color: colors.muted },
  rate: { gap: space.xs, padding: space.sm, borderRadius: radius.field, backgroundColor: "#fafaf9" },
  rateText: { fontSize: font.sm, color: colors.muted },
  converted: { fontSize: font.base, fontWeight: "600", color: colors.text },
  people: { gap: space.xs },
  person: { flexDirection: "row", alignItems: "center", gap: space.sm },
  value: { width: 96, minHeight: 40, borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: radius.field, paddingHorizontal: space.sm, textAlign: "right", fontSize: font.base, color: colors.text, backgroundColor: colors.card },
  share: { width: 96, textAlign: "right", fontSize: font.sm, color: colors.muted },
  problem: { fontSize: font.sm, color: colors.owes },
});
