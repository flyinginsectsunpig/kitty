"use client";

import { convertMinor, formatMoney, parseMoney, parseRate, previewSplit, supportedCurrencies, type SplitMethod } from "@kitty/money";
import { useEffect, useMemo, useState } from "react";
import { CATEGORIES, describeRate, splitProblemMessage, toExpenseWriteDto, type ExpenseFormState } from "@kitty/core";

type Member = { id: string; displayName: string };

/** The rate a saved expense already has (edit only). */
export type SavedRate = { currency: string; occurredOn: string; fxRate: string | null; fxRateDate: string | null; fxRateSource: string | null };

type Quote = { rate: string; rateDate: string } | "failed" | null;

const METHODS: { value: SplitMethod; label: string; hint: string }[] = [
  { value: "equal", label: "Equally", hint: "" },
  { value: "exact", label: "Amounts", hint: "amount" },
  { value: "percent", label: "Percent", hint: "%" },
  { value: "shares", label: "Shares", hint: "shares" },
];

export function ExpenseForm({
  groupId,
  members,
  initial,
  idempotencyKey,
  action,
  submitLabel,
  groupCurrency,
  fetchRate,
  saved,
}: {
  groupId: string;
  members: Member[];
  initial: ExpenseFormState;
  idempotencyKey: string;
  action: (form: FormData) => Promise<void>;
  submitLabel: string;
  groupCurrency: string;
  fetchRate: (groupId: string, currency: string, date: string) => Promise<{ rate: string; rateDate: string } | null>;
  saved?: SavedRate;
}) {
  const [state, setState] = useState<ExpenseFormState>(initial);
  const [quote, setQuote] = useState<Quote>(null);
  const foreign = state.currency !== groupCurrency;
  // An unchanged currency and date keep the saved rate (the ledger does the same); anything else shows the ECB rate.
  const keepsSaved = !!saved?.fxRate && saved.currency === state.currency && saved.occurredOn === state.occurredOn;

  useEffect(() => {
    if (!foreign || keepsSaved || !/^\d{4}-\d{2}-\d{2}$/.test(state.occurredOn)) {
      setQuote(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      fetchRate(groupId, state.currency, state.occurredOn)
        .then((q) => live && setQuote(q ?? "failed"))
        .catch(() => live && setQuote("failed"));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [foreign, keepsSaved, groupId, state.currency, state.occurredOn, fetchRate]);
  const dto = useMemo(() => toExpenseWriteDto(state), [state]);
  const nameOf = (id: string) => members.find((m) => m.id === id)?.displayName ?? "Someone";

  const preview = useMemo(() => {
    if ("error" in dto || dto.split.method === "itemized") return null;
    const participants = dto.split.participants.map((p) => ({ memberId: p.memberId, value: p.value ?? null }));
    return previewSplit(dto.amountMinor, dto.split.method, participants);
  }, [dto]);

  const set = <K extends keyof ExpenseFormState>(key: K, value: ExpenseFormState[K]) => setState((s) => ({ ...s, [key]: value }));
  const setParticipant = (memberId: string, patch: Partial<ExpenseFormState["participants"][number]>) =>
    setState((s) => ({ ...s, participants: s.participants.map((p) => (p.memberId === memberId ? { ...p, ...patch } : p)) }));

  const amountMinor = parseMoney(state.amount, state.currency);
  const touched = state.amount !== "" || state.description !== "";
  const problem = "error" in dto ? dto.error : preview && "error" in preview ? splitProblemMessage(preview.error) : null;

  return (
    <form action={action} className="card space-y-5">
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="payload" value={"error" in dto ? "" : JSON.stringify(dto)} />

      <div>
        <label htmlFor="description" className="label">What was it for?</label>
        <input id="description" required maxLength={120} className="field" placeholder="Groceries, Uber, electricity…"
          value={state.description} onChange={(e) => set("description", e.target.value)} />
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-3">
        <div>
          <label htmlFor="amount" className="label">Amount</label>
          <input id="amount" inputMode="decimal" required className="field text-lg" placeholder="0.00"
            value={state.amount} onChange={(e) => set("amount", e.target.value)} />
        </div>
        <div>
          <label htmlFor="currency" className="label">Currency</label>
          <select id="currency" className="field" value={state.currency} onChange={(e) => setState((s) => ({ ...s, currency: e.target.value, fxRate: "" }))}>
            {supportedCurrencies.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="payer" className="label">Paid by</label>
          <select id="payer" className="field" value={state.payerId} onChange={(e) => set("payerId", e.target.value)}>
            {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="occurredOn" className="label">Date</label>
          <input id="occurredOn" type="date" required className="field" value={state.occurredOn}
            onChange={(e) => setState((s) => ({ ...s, occurredOn: e.target.value, fxRate: "" }))} />
        </div>
      </div>

      {foreign && (
        <RatePanel state={state} groupCurrency={groupCurrency} quote={quote} saved={keepsSaved ? saved : undefined}
          amountMinor={amountMinor} onRate={(v) => set("fxRate", v)} />
      )}

      <div>
        <label htmlFor="category" className="label">Category</label>
        <select id="category" className="field" value={state.category} onChange={(e) => set("category", e.target.value)}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c[0]!.toUpperCase() + c.slice(1)}</option>)}
        </select>
      </div>

      <fieldset className="space-y-3">
        <legend className="label">Split</legend>
        <div role="radiogroup" className="grid grid-cols-4 gap-1 rounded-xl bg-stone-100 p-1 text-sm dark:bg-stone-800">
          {METHODS.map((m) => (
            <button key={m.value} type="button" role="radio" aria-checked={state.method === m.value}
              onClick={() => set("method", m.value)}
              className="rounded-lg py-1.5 font-medium text-stone-600 aria-checked:bg-white aria-checked:text-stone-900 aria-checked:shadow-sm dark:text-stone-300 dark:aria-checked:bg-stone-900 dark:aria-checked:text-stone-100">
              {m.label}
            </button>
          ))}
        </div>

        <ul className="space-y-2">
          {state.participants.map((p) => {
            const share = preview && !("error" in preview) ? preview.find((s) => s.memberId === p.memberId) : undefined;
            const method = METHODS.find((m) => m.value === state.method)!;
            return (
              <li key={p.memberId} className="flex items-center gap-3">
                <label className="flex flex-1 items-center gap-2">
                  <input type="checkbox" className="size-4 accent-brand-600" checked={p.included}
                    onChange={(e) => setParticipant(p.memberId, { included: e.target.checked })} />
                  <span>{nameOf(p.memberId)}</span>
                </label>
                {state.method !== "equal" && p.included && (
                  <input aria-label={`${nameOf(p.memberId)} ${method.hint}`} inputMode="decimal" className="field w-24 py-1.5 text-right"
                    placeholder={method.hint} value={p.value} onChange={(e) => setParticipant(p.memberId, { value: e.target.value })} />
                )}
                <span className="w-24 text-right text-sm tabular-nums text-stone-600 dark:text-stone-400">
                  {share ? formatMoney(share.minor, state.currency) : ""}
                </span>
              </li>
            );
          })}
        </ul>
      </fieldset>

      {touched && problem && <p role="alert" className="text-sm text-owes">{problem}</p>}

      <button className="btn-primary w-full text-base" disabled={"error" in dto || (preview !== null && "error" in preview)}>
        {submitLabel}
        {amountMinor ? ` · ${formatMoney(amountMinor, state.currency)}` : ""}
      </button>
    </form>
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
    ? { rate: saved.fxRate, rateDate: saved.fxRateDate, source: saved.fxRateSource ?? "ecb" }
    : quote && quote !== "failed" ? { rate: quote.rate, rateDate: quote.rateDate, source: "ecb" } : null;
  const typed = parseRate(state.fxRate.trim());
  const rate = typed ?? shown?.rate ?? null;

  return (
    <div className="space-y-2 rounded-xl bg-stone-50 p-3 text-sm dark:bg-stone-900">
      <p className="text-stone-600 dark:text-stone-400">
        {shown ? describeRate({ from: state.currency, to: groupCurrency, ...shown })
          : quote === "failed" ? "Couldn't get the ECB rate. Type it below, or save and add it later."
          : "Getting the ECB rate…"}
      </p>
      {rate && amountMinor ? (
        <p className="font-medium tabular-nums">≈ {formatMoney(convertMinor(amountMinor, rate, state.currency, groupCurrency), groupCurrency)}</p>
      ) : null}
      <label htmlFor="fxRate" className="label">Edit rate (1 {state.currency} in {groupCurrency})</label>
      <input id="fxRate" inputMode="decimal" className="field" placeholder={shown?.rate ?? "e.g. 19.5"}
        value={state.fxRate} onChange={(e) => onRate(e.target.value)} />
    </div>
  );
}
