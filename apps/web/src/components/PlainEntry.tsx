"use client";

import {
  afterParse,
  applyPick,
  askMessages,
  canSave,
  coverLines,
  coverNote,
  draftMoney,
  draftShares,
  routeFirst,
  tickedOf,
  toggleCover,
  withCounterpart,
  type DraftIssue,
  type OpenItem,
  type PlainDraft,
  type Turn,
} from "@kitty/core";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  askQuestion,
  finishDraftAction,
  readSentence,
  rematchGroup,
  saveDraft,
  savePayment,
  sendReminder,
} from "@/app/plain-entry/actions";
import { dayMonth } from "@/lib/day-month";
import { ErrorBanner } from "./ErrorBanner";

/** Errors after which a retry should replay the same request (same key): it may not have finished, or never arrived. */
const KEEP_KEY = new Set(["request_in_progress", "unexpected", "network"]);

/** The key the expense form reads a handed-over draft from (once), so the sentence never goes into a URL. */
export const DRAFT_KEY = "kitty.draft";

export const NOTICE =
  "What you type is sent to an AI model: Google's Gemini, unless this Kitty server runs its own. For questions, so are the details Kitty looks up to answer them: amounts, descriptions and names from your groups.";

/**
 * Type an expense or a reminder in one sentence (check the card; Save or Send: nothing is saved until then), or ask
 * about your money. A question opens a short conversation; follow-ups go to Ask Kitty until New conversation.
 * groupId: the group page it's on, if any (a group named in the sentence wins).
 * initial: a draft an assistant made (MCP), opened from its link; once saved or sent, its link stops working.
 */
export function PlainEntry({
  groupId,
  initial,
}: {
  groupId?: string;
  initial?: { draft: PlainDraft; draftId: string };
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>(() => (initial ? [{ role: "draft", draft: initial.draft }] : []));
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string[] | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, start] = useTransition();

  // The assistant's draft is used up once it's saved or sent.
  const finished = async () => {
    if (initial) await finishDraftAction(initial.draftId);
  };

  const run = (work: () => Promise<void>) =>
    start(async () => {
      setError(undefined);
      setDone(null);
      try {
        await work();
      } catch {
        setError("network");
      }
    });

  // The card being checked is the last turn, when it's a draft.
  const last = turns.at(-1);
  const draft = last?.role === "draft" ? last.draft : null;
  const setDraft = (next: PlainDraft | null) =>
    setTurns((ts) => {
      const rest = ts.at(-1)?.role === "draft" ? ts.slice(0, -1) : ts;
      return next ? [...rest, { role: "draft", draft: next }] : rest;
    });

  const say = (message: string) =>
    run(async () => {
      // An unsaved card is dropped when the person moves on.
      const before = turns.filter((t) => t.role !== "draft");
      let convo: Turn[] = [...before, { role: "person", text: message }];
      const add = (t: Turn) => {
        convo = [...convo, t];
        setTurns(convo);
      };
      setTurns(convo);
      setText("");

      const ask = async (): Promise<void> => {
        const r = await askQuestion(askMessages(convo), groupId);
        if ("error" in r) return add({ role: "error", code: r.error });
        if ("entry" in r) return parse(true);
        add({ role: "kitty", text: r.answer });
      };
      const parse = async (cameFromAsk: boolean): Promise<void> => {
        const r = await readSentence(message, groupId);
        if (r.error || !r.draft) return add({ role: "error", code: r.error ?? "unexpected" });
        const next = afterParse(r.draft, cameFromAsk);
        if (next === "ask") return ask();
        if (next === "unclear") return add({ role: "error", code: "unclear" });
        add({ role: "draft", draft: r.draft });
        setKey(crypto.randomUUID());
      };

      await (routeFirst(before) === "parse" ? parse(false) : ask());
    });

  const startOver = () => {
    setTurns([]);
    setText("");
    setError(undefined);
    setDone(null);
  };

  const pickGroup = (id: string) =>
    run(async () => {
      if (!draft) return;
      const r = await rematchGroup(draft.parsed, id);
      if (r.error) return setError(r.error);
      setDraft(r.draft ?? null);
      setKey(crypto.randomUUID());
    });

  // A payment's other person, picked on the card: the sentence is matched again with that name.
  const pickCounterpart = (memberId: string) =>
    run(async () => {
      const picked = draft?.members.find((m) => m.id === memberId);
      if (!draft?.groupId || !picked) return;
      const r = await rematchGroup(withCounterpart(draft.parsed, picked.displayName), draft.groupId);
      if (r.error) return setError(r.error);
      setDraft(r.draft ?? null);
      setKey(crypto.randomUUID());
    });

  const pay = () =>
    run(async () => {
      if (!draft?.groupId || draft.intent !== "payment") return;
      const r = await savePayment(draft, key);
      if (r.error) {
        if (!KEEP_KEY.has(r.error)) setKey(crypto.randomUUID());
        return setError(r.error);
      }
      await finished();
      setDone(r.countingBoth ? ["Payment recorded.", r.countingBoth] : ["Payment recorded."]);
      setDraft(null);
      router.refresh();
    });

  const save = () =>
    run(async () => {
      if (!draft?.groupId) return;
      const code = await saveDraft(draft, key);
      if (code) {
        if (!KEEP_KEY.has(code)) setKey(crypto.randomUUID());
        return setError(code);
      }
      await finished();
      setDraft(null);
      router.push(`/groups/${draft.groupId}`);
      router.refresh();
    });

  const send = () =>
    run(async () => {
      if (!draft?.groupId || !draft.reminder?.memberId) return;
      const code = await sendReminder(draft.groupId, draft.reminder.memberId, key);
      if (code) {
        if (!KEEP_KEY.has(code)) setKey(crypto.randomUUID());
        return setError(code);
      }
      await finished();
      setDone([`Reminder sent to ${draft.reminder.name ?? "them"}.`]);
      setDraft(null);
    });

  const edit = () => {
    if (!draft?.groupId) return;
    // The form saves it from here on, so an assistant's link stops working now: opening it again must not offer a
    // second Save.
    void finished();
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // Private mode: the form opens empty.
    }
    router.push(`/groups/${draft.groupId}/expenses/new?draft=1`);
  };

  return (
    <div className="card space-y-3">
      {turns.some((t) => t.role !== "draft") && (
        <div className="space-y-2" aria-live="polite" aria-label="Conversation with Kitty">
          {turns.map((t, i) =>
            t.role === "person" ? (
              <p key={i} className="ml-8 rounded-xl bg-stone-100 p-2 text-sm dark:bg-stone-800">
                {t.text}
              </p>
            ) : t.role === "kitty" ? (
              <p key={i} className="mr-8 whitespace-pre-line rounded-xl border border-stone-200 p-2 text-sm dark:border-stone-700">
                {t.text}
              </p>
            ) : t.role === "error" ? (
              <ErrorBanner key={i} code={t.code} />
            ) : null,
          )}
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) say(text.trim());
        }}
      >
        <label htmlFor="plain-entry" className="sr-only">
          Add an expense or a reminder in a sentence, or ask about your money
        </label>
        <input
          id="plain-entry"
          className="field"
          value={text}
          maxLength={500}
          onChange={(e) => setText(e.target.value)}
          placeholder={routeFirst(turns) === "ask" ? "Ask a follow-up" : "petrol R600 with Sam, or: how much do I owe?"}
        />
        <button className="btn-primary" disabled={busy || !text.trim()}>
          {busy && !draft ? "Reading…" : "Go"}
        </button>
      </form>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-stone-500">{NOTICE}</p>
        {turns.length > 0 && (
          <button type="button" className="btn-secondary shrink-0 text-xs" disabled={busy} onClick={startOver}>
            New conversation
          </button>
        )}
      </div>
      <ErrorBanner code={error} />
      {done && (
        <div className="space-y-1 rounded-xl bg-green-50 p-3 text-sm text-owed dark:bg-green-950">
          {done.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
      {draft && (
        <DraftCard
          draft={draft}
          busy={busy}
          onPick={(i, memberId) => {
            setDraft(applyPick(draft, i, memberId));
            setKey(crypto.randomUUID()); // a changed draft is a different request
          }}
          onPickGroup={pickGroup}
          onPickCounterpart={pickCounterpart}
          onToggle={(expenseId) => {
            setDraft(toggleCover(draft, expenseId));
            setKey(crypto.randomUUID());
          }}
          onSave={draft.intent === "payment" ? pay : save}
          onSend={send}
          onEdit={edit}
          onCancel={() => setDraft(null)}
        />
      )}
    </div>
  );
}

function DraftCard({
  draft,
  busy,
  onPick,
  onPickGroup,
  onPickCounterpart,
  onToggle,
  onSave,
  onSend,
  onEdit,
  onCancel,
}: {
  draft: PlainDraft;
  busy: boolean;
  /** memberId is the picked member, or for a payment item the picked expense; null leaves it out. */
  onPick: (issueIndex: number, memberId: string | null) => void;
  onPickGroup: (groupId: string) => void;
  onPickCounterpart: (memberId: string) => void;
  onToggle: (expenseId: string) => void;
  onSave: () => void;
  onSend: () => void;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const nameOf = (id: string | null) => draft.members.find((m) => m.id === id)?.displayName ?? "?";
  const group = draft.groups.find((g) => g.id === draft.groupId);
  const groupIssue = draft.issues.findIndex((i) => i.field === "group");

  return (
    <div className="space-y-3 rounded-xl border border-stone-200 p-3 dark:border-stone-700" aria-label="Check before saving">
      {draft.intent === "unclear" && (
        <p className="text-sm">Kitty couldn&apos;t tell what to do with that. Try other words, or use the form.</p>
      )}

      {draft.intent === "expense" && draft.expense && <ExpenseSummary draft={draft} nameOf={nameOf} />}
      {draft.intent === "reminder" && draft.reminder && <ReminderSummary draft={draft} groupName={group?.name} />}
      {draft.intent === "payment" && draft.payment && (
        <PaymentSummary draft={draft} nameOf={nameOf} busy={busy} onToggle={onToggle} />
      )}

      {groupIssue >= 0 || !draft.groupId ? (
        <label className="block text-sm">
          Which group?{" "}
          <select className="field mt-1" defaultValue="" onChange={(e) => e.target.value && onPickGroup(e.target.value)}>
            <option value="" disabled>
              Pick a group
            </option>
            {draft.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        group && (
          <p className="text-xs text-stone-500">
            In {group.name}
            {draft.groups.length > 1 && (
              <>
                {" · "}
                <select
                  className="bg-transparent underline"
                  aria-label="Another group"
                  value={group.id}
                  onChange={(e) => onPickGroup(e.target.value)}
                >
                  {draft.groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </>
            )}
          </p>
        )
      )}

      {draft.issues.map((issue, i) =>
        issue.field === "group" ? null : issue.field.startsWith("payment") ? (
          <PaymentIssue
            key={`${issue.field}-${i}`}
            issue={issue}
            draft={draft}
            nameOf={nameOf}
            onPickItem={(expenseId) => onPick(i, expenseId)}
            onPickCounterpart={onPickCounterpart}
          />
        ) : (
          <IssuePicker key={`${issue.field}-${i}`} issue={issue} draft={draft} onPick={(m) => onPick(i, m)} />
        ),
      )}

      <div className="flex flex-wrap gap-2">
        {draft.intent === "expense" && (
          <>
            <button className="btn-primary" disabled={busy || !canSave(draft)} onClick={onSave}>
              Save
            </button>
            <button className="btn-secondary" disabled={busy || !draft.groupId} onClick={onEdit}>
              Edit
            </button>
          </>
        )}
        {draft.intent === "payment" && (
          <button className="btn-primary" disabled={busy || !canSave(draft)} onClick={onSave}>
            Save
          </button>
        )}
        {draft.intent === "reminder" && (
          <button
            className="btn-primary"
            disabled={busy || !canSave(draft) || (draft.reminder?.owedMinorByCurrency !== null && Object.keys(draft.reminder?.owedMinorByCurrency ?? {}).length === 0)}
            onClick={onSend}
          >
            Send reminder
          </button>
        )}
        <button className="btn-secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ExpenseSummary({ draft, nameOf }: { draft: PlainDraft; nameOf: (id: string | null) => string }) {
  const e = draft.expense!;
  const total = e.amountMinor === null ? "amount?" : draftMoney(e.amountMinor, e.currency);
  const shares = draftShares(draft);
  const people = e.participants.map((p, i) => {
    const who = p.memberId ? nameOf(p.memberId) : p.name;
    const share = shares[i];
    return share !== null && share !== undefined ? `${who} ${draftMoney(share, e.currency)}` : who;
  });
  return (
    <div className="space-y-1">
      <p className="font-semibold">
        {e.description} · <span className="tabular-nums">{total}</span> · {e.occurredOn}
      </p>
      <p className="text-sm">
        Paid by {e.payerMemberId ? nameOf(e.payerMemberId) : "?"} · {e.split === "amounts" ? "split by amounts" : "split equally"}
      </p>
      <p className="text-sm text-stone-600 dark:text-stone-400">{people.join(" · ")}</p>
    </div>
  );
}

function ReminderSummary({ draft, groupName }: { draft: PlainDraft; groupName?: string }) {
  const r = draft.reminder!;
  const owed = r.owedMinorByCurrency;
  const owedText = owed && Object.keys(owed).length > 0
    ? Object.entries(owed).map(([c, m]) => draftMoney(m, c)).join(" and ")
    : null;
  const stated = r.statedAmountMinor !== null ? draftMoney(r.statedAmountMinor, r.statedCurrency) : null;
  const differs = stated && owed && !(Object.keys(owed).length === 1 && owed[r.statedCurrency] === r.statedAmountMinor);
  return (
    <div className="space-y-1">
      {owed === null ? (
        <p className="font-semibold">Remind {r.name ?? "them"} what they owe you{groupName ? ` in ${groupName}` : ""}?</p>
      ) : owedText ? (
        <p className="font-semibold">
          Remind {r.name ?? "them"} that they owe you <span className="tabular-nums">{owedText}</span>
          {groupName ? ` in ${groupName}` : ""}?
        </p>
      ) : (
        <p className="text-sm">{r.name ?? "They"} don&apos;t owe you anything in {groupName ?? "this group"}.</p>
      )}
      {differs && owedText && (
        <p className="text-sm text-stone-600 dark:text-stone-400">
          You said {stated}; Kitty&apos;s balance says {owedText}.
        </p>
      )}
    </div>
  );
}

/** The resolver's reading of who paid: "they_paid" means the other person paid you; anything else, you paid them. */
function theyPaid(draft: PlainDraft): boolean {
  return (draft.parsed as { direction?: unknown } | null)?.direction === "they_paid";
}

/** The other person on a payment (null until matched), and you. */
function sides(draft: PlainDraft): { other: string | null; me: string | null } {
  const p = draft.payment;
  if (!p) return { other: null, me: null };
  return theyPaid(draft) ? { other: p.fromMemberId, me: p.toMemberId } : { other: p.toMemberId, me: p.fromMemberId };
}

function itemLine(item: OpenItem, currency: string): string {
  return `${item.description} · ${dayMonth(item.date)} · ${draftMoney(item.openMinor, currency)} open`;
}

function PaymentSummary({
  draft,
  nameOf,
  busy,
  onToggle,
}: {
  draft: PlainDraft;
  nameOf: (id: string | null) => string;
  busy: boolean;
  onToggle: (expenseId: string) => void;
}) {
  const p = draft.payment!;
  const { other } = sides(draft);
  const name = other ? nameOf(other) : "someone";
  const amount = p.amountMinor === null ? "amount?" : draftMoney(p.amountMinor, p.currency);
  const ticked = tickedOf(p);
  const notes = coverLines(p.openItems, ticked, p.covers)
    .map((l) => ({ id: l.expenseId, text: coverNote(l, p.currency) }))
    .filter((n) => n.text !== null);
  return (
    <div className="space-y-2">
      <p className="font-semibold">
        {theyPaid(draft) ? `${name} paid you ` : `You paid ${name} `}
        <span className="tabular-nums">{amount}</span>
      </p>
      {p.openItems.length > 0 && (
        <ul className="space-y-1 text-sm">
          {p.openItems.map((item) => (
            <li key={item.expenseId}>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 accent-brand-600"
                  checked={ticked.includes(item.expenseId)}
                  disabled={busy}
                  onChange={() => onToggle(item.expenseId)}
                />
                <span className="tabular-nums">{itemLine(item, p.currency)}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {notes.map((n) => (
        <p key={n.id} className="text-sm tabular-nums text-stone-600 dark:text-stone-400">
          {n.text}
        </p>
      ))}
    </div>
  );
}

/** A payment issue fixed on the card: pick the other person or an item, or a short note when it can't be fixed here. */
function PaymentIssue({
  issue,
  draft,
  nameOf,
  onPickItem,
  onPickCounterpart,
}: {
  issue: DraftIssue;
  draft: PlainDraft;
  nameOf: (id: string | null) => string;
  onPickItem: (expenseId: string | null) => void;
  onPickCounterpart: (memberId: string) => void;
}) {
  const p = draft.payment;
  const { other, me } = sides(draft);

  if (issue.field === "payment.counterpart") {
    const choices =
      issue.kind === "ambiguous"
        ? draft.members.filter((m) => issue.candidates.includes(m.id))
        : draft.members.filter((m) => m.id !== me);
    const question =
      issue.kind === "ambiguous"
        ? `Which ${issue.text}?`
        : issue.text
          ? `“${issue.text}” isn't someone you can pay in this group. Who did you mean?`
          : "Who was the payment with?";
    return (
      <label className="block text-sm">
        {question}
        <select className="field mt-1" defaultValue="" onChange={(e) => e.target.value && onPickCounterpart(e.target.value)}>
          <option value="" disabled>
            Pick someone
          </option>
          {choices.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (issue.kind === "other_currency") {
    const what = issue.field.startsWith("payment.items[") && issue.text ? `“${issue.text}” is in another currency. ` : "";
    return <p className="text-sm text-owes">{what}Record this one in Settle up.</p>;
  }
  if (issue.field === "payment.items") {
    return <p className="text-sm text-owes">Nothing is open with {other ? nameOf(other) : "them"} right now.</p>;
  }
  if (issue.field === "payment.amount") {
    return <p className="text-sm text-owes">Kitty couldn&apos;t read the amount. Try again with it, like R25.</p>;
  }

  // payment.items[n]: a phrase that matched several open items, or none.
  const choices = (p?.openItems ?? []).filter((item) => issue.candidates.includes(item.expenseId));
  const question =
    issue.kind === "ambiguous" ? `Which ${issue.text}?` : `Nothing open matches “${issue.text}”. Which one did you mean?`;
  return (
    <label className="block text-sm">
      {question}
      <select
        className="field mt-1"
        defaultValue=""
        onChange={(e) => onPickItem(e.target.value === "__out" ? null : e.target.value)}
      >
        <option value="" disabled>
          Pick one
        </option>
        {choices.map((item) => (
          <option key={item.expenseId} value={item.expenseId}>
            {itemLine(item, p?.currency ?? "")}
          </option>
        ))}
        <option value="__out">Leave it out</option>
      </select>
    </label>
  );
}

function IssuePicker({ issue, draft, onPick }: { issue: DraftIssue; draft: PlainDraft; onPick: (memberId: string | null) => void }) {
  const pickable = issue.field === "payer" || issue.field === "reminder.member" || /^people\[\d+\]$/.test(issue.field);
  if (!pickable) {
    const what =
      issue.kind === "mismatch"
        ? "The total doesn't match the amounts. Use Edit to fix it."
        : issue.field.endsWith(".amount")
          ? `No amount for ${issue.text || "someone"}. Use Edit to add it.`
          : "No amount found. Use Edit to add it.";
    return <p className="text-sm text-owes">{what}</p>;
  }
  const choices = issue.kind === "ambiguous" ? draft.members.filter((m) => issue.candidates.includes(m.id)) : draft.members;
  const question =
    issue.kind === "ambiguous" ? `Which ${issue.text}?` : issue.text ? `“${issue.text}” isn't in this group. Who did you mean?` : "Who?";
  const canLeaveOut = /^people\[\d+\]$/.test(issue.field);
  return (
    <label className="block text-sm">
      {question}
      <select
        className="field mt-1"
        defaultValue=""
        onChange={(e) => onPick(e.target.value === "__out" ? null : e.target.value)}
      >
        <option value="" disabled>
          Pick someone
        </option>
        {choices.map((m) => (
          <option key={m.id} value={m.id}>
            {m.displayName}
          </option>
        ))}
        {canLeaveOut && <option value="__out">Leave them out</option>}
      </select>
    </label>
  );
}
