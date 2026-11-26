import type { LedgerClient } from "@kitty/api-client";
import {
  afterParse,
  applyPick,
  askMessages,
  canSave,
  countingBoth,
  coverLines,
  coverNote,
  draftMoney,
  draftShares,
  draftToForm,
  errorMessage,
  routeFirst,
  tickedOf,
  toExpenseWriteDto,
  toSettlementWriteDto,
  toggleCover,
  withCounterpart,
  type DraftIssue,
  type OpenItem,
  type PlainDraft,
  type Turn,
} from "@kitty/core";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { useAi } from "../ai";
import { useAction } from "../hooks/useAction";
import { useLedger } from "../ledger";
import { dayMonth } from "../lib/day-month";
import { handOverDraft } from "../plain-entry/handOver";
import { colors, font, radius, space } from "../theme";
import { Button } from "./Button";
import { Checkbox } from "./Checkbox";
import { ErrorBanner } from "./ErrorBanner";
import { Card } from "./Screen";

export const NOTICE =
  "What you type is sent to an AI model: Google's Gemini, unless this Kitty server runs its own. For questions, so are the details Kitty looks up to answer them: amounts, descriptions and names from your groups.";

/**
 * Type an expense or a reminder in one sentence (the keyboard's microphone works too), check the card, then Save
 * or Send: nothing is saved until then. Or ask about your money: a question opens a short conversation, and
 * follow-ups go to Ask Kitty until New conversation. groupId: the group screen it's on, if any.
 */
export function PlainEntry({ groupId }: { groupId?: string }) {
  const ai = useAi();
  const ledger = useLedger();
  const router = useRouter();
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [done, setDone] = useState<string[] | null>(null);

  // The card being checked is the last turn, when it's a draft.
  const last = turns.at(-1);
  const draft = last?.role === "draft" ? last.draft : null;
  const setDraft = (next: PlainDraft | null) =>
    setTurns((ts) => {
      const rest = ts.at(-1)?.role === "draft" ? ts.slice(0, -1) : ts;
      return next ? [...rest, { role: "draft", draft: next }] : rest;
    });

  const read = async (work: () => ReturnType<typeof ai.parse>) => {
    setReading(true);
    setReadError(null);
    setDone(null);
    const r = await work();
    setReading(false);
    if (r.error) return setReadError(errorMessage(r.error));
    setDraft(r.draft ?? null);
  };

  const say = async (message: string) => {
    setReading(true);
    setReadError(null);
    setDone(null);
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
      const r = await ai.ask(askMessages(convo), groupId);
      if ("error" in r) return add({ role: "error", code: r.error });
      if ("entry" in r) return parse(true);
      add({ role: "kitty", text: r.answer });
    };
    const parse = async (cameFromAsk: boolean): Promise<void> => {
      const r = await ai.parse(message, groupId);
      if (r.error || !r.draft) return add({ role: "error", code: r.error ?? "unexpected" });
      const next = afterParse(r.draft, cameFromAsk);
      if (next === "ask") return ask();
      if (next === "unclear") return add({ role: "error", code: "unclear" });
      add({ role: "draft", draft: r.draft });
    };

    try {
      await (routeFirst(before) === "parse" ? parse(false) : ask());
    } finally {
      setReading(false);
    }
  };

  const startOver = () => {
    setTurns([]);
    setText("");
    setReadError(null);
    setDone(null);
  };

  const save = useAction(
    useCallback(
      (key: string) => {
        // The expense id is the request's key: a retry sends the same id, so the ledger replays instead of refusing.
        const body = toExpenseWriteDto(draftToForm(draft!, { id: key }));
        if ("error" in body) throw new Error(body.error); // canSave already checked; a bug if reached
        return ledger.POST("/groups/{groupId}/expenses", {
          params: { path: { groupId: draft!.groupId! } },
          body,
          headers: { "Idempotency-Key": key },
        });
      },
      [ledger, draft],
    ),
  );
  const send = useAction(
    useCallback(
      (key: string) =>
        ledger.POST("/groups/{groupId}/reminders", {
          params: { path: { groupId: draft!.groupId! } },
          body: { memberId: draft!.reminder!.memberId! },
          headers: { "Idempotency-Key": key },
        }),
      [ledger, draft],
    ),
  );

  const pay = useAction(
    useCallback(
      (key: string) =>
        // The settlement id is the request's key, as for an expense: a retry replays instead of paying twice.
        ledger.POST("/groups/{groupId}/settlements", {
          params: { path: { groupId: draft!.groupId! } },
          body: toSettlementWriteDto(draft!, key),
          headers: { "Idempotency-Key": key },
        }),
      [ledger, draft],
    ),
  );
  // A changed card (a tick, a pick, another reading) is a different request, so it gets a new key. A retry of the
  // same card keeps its key.
  const renewPayKey = pay.renew;
  useEffect(() => renewPayKey(), [draft, renewPayKey]);

  const finish = (message: string[] | null) => {
    setDraft(null);
    setText("");
    setDone(message);
  };

  const savePayment = (d: PlainDraft) =>
    void pay.run().then(async (r) => {
      if (!r.ok) return;
      const p = d.payment!;
      const recorded = ["Payment recorded."];
      finish(recorded); // the card goes at once, so it can't be saved twice; the line below is only extra
      const line = await countingBothAfter(ledger, d.groupId!, p.fromMemberId!, p.toMemberId!, p.currency).catch(() => null);
      if (line) setDone((now) => (now === recorded ? [...recorded, line] : now));
    });

  // A payment's other person, picked on the card: the sentence is matched again with that name.
  const pickCounterpart = (d: PlainDraft, memberId: string) => {
    const picked = d.members.find((m) => m.id === memberId);
    const groupId = d.groupId;
    if (!groupId || !picked) return;
    void read(() => ai.resolve(withCounterpart(d.parsed, picked.displayName), groupId));
  };

  return (
    <Card>
      {turns.some((t) => t.role !== "draft") && (
        <View style={styles.conversation} accessibilityLabel="Conversation with Kitty" accessibilityLiveRegion="polite">
          {turns.map((t, i) =>
            t.role === "person" ? (
              <Text key={i} style={styles.mine}>
                {t.text}
              </Text>
            ) : t.role === "kitty" ? (
              <Text key={i} style={styles.kitty}>
                {t.text}
              </Text>
            ) : t.role === "error" ? (
              <ErrorBanner key={i} message={errorMessage(t.code)} />
            ) : null,
          )}
        </View>
      )}
      <View style={styles.row}>
        <TextInput
          accessibilityLabel="Add an expense or a reminder in a sentence"
          style={styles.field}
          value={text}
          maxLength={500}
          onChangeText={setText}
          placeholder={routeFirst(turns) === "ask" ? "Ask a follow-up" : "petrol R600 with Sam, or: how much do I owe?"}
          placeholderTextColor={colors.faint}
          returnKeyType="go"
          onSubmitEditing={() => text.trim() && !reading && void say(text.trim())}
        />
        <Button title="Go" busy={reading} disabled={!text.trim()} onPress={() => void say(text.trim())} />
      </View>
      <Text style={styles.note}>{NOTICE}</Text>
      {turns.length > 0 && <Button title="New conversation" variant="secondary" disabled={reading} onPress={startOver} />}
      <ErrorBanner message={readError ?? save.error ?? send.error ?? pay.error} />
      {done?.map((line) => (
        <Text key={line} style={styles.success}>
          {line}
        </Text>
      ))}
      {draft && (
        <DraftCard
          draft={draft}
          busy={reading || save.busy || send.busy || pay.busy}
          onPick={(i, memberId) => setDraft(applyPick(draft, i, memberId))}
          onPickGroup={(id) => void read(() => ai.resolve(draft.parsed, id))}
          onPickCounterpart={(memberId) => pickCounterpart(draft, memberId)}
          onToggle={(expenseId) => setDraft(toggleCover(draft, expenseId))}
          onSavePayment={() => savePayment(draft)}
          onSave={() =>
            void save.run().then((r) => {
              if (!r.ok) return;
              const to = draft.groupId!;
              finish(null);
              router.push(`/groups/${to}`);
            })
          }
          onSend={() => void send.run().then((r) => r.ok && finish([`Reminder sent to ${draft.reminder?.name ?? "them"}.`]))}
          onEdit={() => {
            handOverDraft(draft);
            router.push(`/groups/${draft.groupId}/expenses/new?draft=1`);
          }}
          onCancel={() => setDraft(null)}
        />
      )}
    </Card>
  );
}

function DraftCard(props: {
  draft: PlainDraft;
  busy: boolean;
  /** memberId is the picked member, or for a payment item the picked expense; null leaves it out. */
  onPick: (issueIndex: number, memberId: string | null) => void;
  onPickGroup: (groupId: string) => void;
  onPickCounterpart: (memberId: string) => void;
  onToggle: (expenseId: string) => void;
  onSavePayment: () => void;
  onSave: () => void;
  onSend: () => void;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const { draft, busy } = props;
  const nameOf = (id: string | null) => draft.members.find((m) => m.id === id)?.displayName ?? "?";
  const group = draft.groups.find((g) => g.id === draft.groupId);
  const owed = draft.reminder?.owedMinorByCurrency;
  const nothingOwed = owed !== null && owed !== undefined && Object.keys(owed).length === 0;

  return (
    <View style={styles.card} accessibilityLabel="Check before saving">
      {draft.intent === "unclear" && <Text style={styles.text}>Kitty couldn&apos;t tell what to do with that. Try other words, or use the form.</Text>}
      {draft.intent === "expense" && draft.expense && <ExpenseSummary draft={draft} nameOf={nameOf} />}
      {draft.intent === "reminder" && draft.reminder && <ReminderSummary draft={draft} groupName={group?.name} />}
      {draft.intent === "payment" && draft.payment && <PaymentSummary draft={draft} nameOf={nameOf} busy={busy} onToggle={props.onToggle} />}

      {!draft.groupId ? (
        <View style={styles.picks}>
          <Text style={styles.text}>Which group?</Text>
          {draft.groups.map((g) => (
            <Button key={g.id} title={g.name} variant="secondary" disabled={busy} onPress={() => props.onPickGroup(g.id)} />
          ))}
        </View>
      ) : (
        group && <Text style={styles.note}>In {group.name}</Text>
      )}

      {draft.issues.map((issue, i) =>
        issue.field === "group" ? null : issue.field.startsWith("payment") ? (
          <PaymentIssue
            key={`${issue.field}-${i}`}
            issue={issue}
            draft={draft}
            nameOf={nameOf}
            busy={busy}
            onPickItem={(expenseId) => props.onPick(i, expenseId)}
            onPickCounterpart={props.onPickCounterpart}
          />
        ) : (
          <IssuePicker key={`${issue.field}-${i}`} issue={issue} draft={draft} onPick={(m) => props.onPick(i, m)} />
        ),
      )}

      <View style={styles.picks}>
        {draft.intent === "expense" && (
          <>
            <Button title="Save" disabled={busy || !canSave(draft)} onPress={props.onSave} />
            <Button title="Edit" variant="secondary" disabled={busy || !draft.groupId} onPress={props.onEdit} />
          </>
        )}
        {draft.intent === "payment" && <Button title="Save" disabled={busy || !canSave(draft)} onPress={props.onSavePayment} />}
        {draft.intent === "reminder" && <Button title="Send reminder" disabled={busy || !canSave(draft) || nothingOwed} onPress={props.onSend} />}
        <Button title="Cancel" variant="secondary" disabled={busy} onPress={props.onCancel} />
      </View>
    </View>
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
    <View style={styles.summary}>
      <Text style={styles.title}>
        {e.description} · {total} · {e.occurredOn}
      </Text>
      <Text style={styles.text}>
        Paid by {e.payerMemberId ? nameOf(e.payerMemberId) : "?"} · {e.split === "amounts" ? "split by amounts" : "split equally"}
      </Text>
      <Text style={styles.muted}>{people.join(" · ")}</Text>
    </View>
  );
}

function ReminderSummary({ draft, groupName }: { draft: PlainDraft; groupName?: string }) {
  const r = draft.reminder!;
  const owed = r.owedMinorByCurrency;
  const owedText = owed && Object.keys(owed).length > 0 ? Object.entries(owed).map(([c, m]) => draftMoney(m, c)).join(" and ") : null;
  const stated = r.statedAmountMinor !== null ? draftMoney(r.statedAmountMinor, r.statedCurrency) : null;
  const differs = stated && owed && !(Object.keys(owed).length === 1 && owed[r.statedCurrency] === r.statedAmountMinor);
  const where = groupName ? ` in ${groupName}` : "";
  return (
    <View style={styles.summary}>
      {owed === null ? (
        <Text style={styles.title}>Remind {r.name ?? "them"} what they owe you{where}?</Text>
      ) : owedText ? (
        <Text style={styles.title}>
          Remind {r.name ?? "them"} that they owe you {owedText}
          {where}?
        </Text>
      ) : (
        <Text style={styles.text}>
          {r.name ?? "They"} don&apos;t owe you anything{where || " in this group"}.
        </Text>
      )}
      {differs && owedText && (
        <Text style={styles.muted}>
          You said {stated}; Kitty&apos;s balance says {owedText}.
        </Text>
      )}
    </View>
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

function PaymentSummary({ draft, nameOf, busy, onToggle }: {
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
    <View style={styles.summary}>
      <Text style={styles.title}>{theyPaid(draft) ? `${name} paid you ${amount}` : `You paid ${name} ${amount}`}</Text>
      {p.openItems.map((item) => (
        <Checkbox
          key={item.expenseId}
          label={itemLine(item, p.currency)}
          checked={ticked.includes(item.expenseId)}
          disabled={busy}
          onChange={() => onToggle(item.expenseId)}
        />
      ))}
      {notes.map((n) => (
        <Text key={n.id} style={styles.note}>
          {n.text}
        </Text>
      ))}
    </View>
  );
}

/** A payment issue fixed on the card: pick the other person or an item, or a short note when it can't be fixed here. */
function PaymentIssue({ issue, draft, nameOf, busy, onPickItem, onPickCounterpart }: {
  issue: DraftIssue;
  draft: PlainDraft;
  nameOf: (id: string | null) => string;
  busy: boolean;
  onPickItem: (expenseId: string | null) => void;
  onPickCounterpart: (memberId: string) => void;
}) {
  const p = draft.payment;
  const { other, me } = sides(draft);

  if (issue.field === "payment.counterpart") {
    const choices =
      issue.kind === "ambiguous" ? draft.members.filter((m) => issue.candidates.includes(m.id)) : draft.members.filter((m) => m.id !== me);
    const question =
      issue.kind === "ambiguous"
        ? `Which ${issue.text}?`
        : issue.text
          ? `“${issue.text}” isn't someone you can pay in this group. Who did you mean?`
          : "Who was the payment with?";
    return (
      <View style={styles.picks}>
        <Text style={styles.text}>{question}</Text>
        {choices.map((m) => (
          <Button key={m.id} title={m.displayName} variant="secondary" disabled={busy} onPress={() => onPickCounterpart(m.id)} />
        ))}
      </View>
    );
  }

  if (issue.kind === "other_currency") {
    const what = issue.field.startsWith("payment.items[") && issue.text ? `“${issue.text}” is in another currency. ` : "";
    return <Text style={styles.problem}>{what}Record this one in Settle up.</Text>;
  }
  if (issue.field === "payment.items") {
    return <Text style={styles.problem}>Nothing is open with {other ? nameOf(other) : "them"} right now.</Text>;
  }
  if (issue.field === "payment.amount") {
    return <Text style={styles.problem}>Kitty couldn&apos;t read the amount. Try again with it, like R25.</Text>;
  }

  // payment.items[n]: a phrase that matched several open items, or none.
  const choices = (p?.openItems ?? []).filter((item) => issue.candidates.includes(item.expenseId));
  const question = issue.kind === "ambiguous" ? `Which ${issue.text}?` : `Nothing open matches “${issue.text}”. Which one did you mean?`;
  return (
    <View style={styles.picks}>
      <Text style={styles.text}>{question}</Text>
      {choices.map((item) => (
        <Button key={item.expenseId} title={itemLine(item, p?.currency ?? "")} variant="secondary" disabled={busy} onPress={() => onPickItem(item.expenseId)} />
      ))}
      <Button title="Leave it out" variant="secondary" disabled={busy} onPress={() => onPickItem(null)} />
    </View>
  );
}

/**
 * After a payment: the line comparing what's still open both ways (null when only one side is open, or the ledger
 * can't say; the payment is saved either way).
 */
async function countingBothAfter(ledger: LedgerClient, groupId: string, from: string, to: string, currency: string): Promise<string | null> {
  const [open, me, group] = await Promise.all([
    ledger.GET("/groups/{groupId}/open-items", { params: { path: { groupId }, query: { from, to } } }).then((r) => r.data),
    ledger.GET("/me").then((r) => r.data),
    ledger.GET("/groups/{groupId}", { params: { path: { groupId } } }).then((r) => r.data),
  ]);
  const meMember = group?.members.find((m) => m.userId === me?.id);
  const other = group?.members.find((m) => m.id === (meMember?.id === from ? to : from));
  if (!open || !meMember || !other) return null;
  return countingBoth(open, currency, meMember.id, other.displayName);
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
    return <Text style={styles.problem}>{what}</Text>;
  }
  const choices = issue.kind === "ambiguous" ? draft.members.filter((m) => issue.candidates.includes(m.id)) : draft.members;
  const question = issue.kind === "ambiguous" ? `Which ${issue.text}?` : issue.text ? `“${issue.text}” isn't in this group. Who did you mean?` : "Who?";
  return (
    <View style={styles.picks}>
      <Text style={styles.text}>{question}</Text>
      {choices.map((m) => (
        <Button key={m.id} title={m.displayName} variant="secondary" onPress={() => onPick(m.id)} />
      ))}
      {/^people\[\d+\]$/.test(issue.field) && <Button title="Leave them out" variant="secondary" onPress={() => onPick(null)} />}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: space.sm, alignItems: "center" },
  field: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    borderRadius: radius.field,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: font.base,
    color: colors.text,
    backgroundColor: colors.card,
  },
  note: { fontSize: font.sm, color: colors.muted },
  conversation: { gap: space.sm },
  mine: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    padding: space.sm,
    borderRadius: radius.field,
    backgroundColor: colors.border,
    fontSize: font.base,
    color: colors.text,
  },
  kitty: {
    alignSelf: "flex-start",
    maxWidth: "85%",
    padding: space.sm,
    borderRadius: radius.field,
    borderWidth: 1,
    borderColor: colors.border,
    fontSize: font.base,
    color: colors.text,
  },
  success: { fontSize: font.sm, color: colors.owed },
  card: { gap: space.md, paddingTop: space.sm },
  summary: { gap: space.xs },
  title: { fontSize: font.base, fontWeight: "600", color: colors.text },
  text: { fontSize: font.base, color: colors.text },
  muted: { fontSize: font.sm, color: colors.muted },
  problem: { fontSize: font.sm, color: colors.owes },
  picks: { gap: space.sm },
});
