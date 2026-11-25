import { applyPick, canSave, draftMoney, draftShares, draftToForm, errorMessage, toExpenseWriteDto, type DraftIssue, type PlainDraft } from "@kitty/core";
import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { useAi } from "../ai";
import { useAction } from "../hooks/useAction";
import { useLedger } from "../ledger";
import { handOverDraft } from "../plain-entry/handOver";
import { colors, font, radius, space } from "../theme";
import { Button } from "./Button";
import { ErrorBanner } from "./ErrorBanner";
import { Card } from "./Screen";

/**
 * Type an expense or a reminder in one sentence (the keyboard's microphone works too), check the card, then Save
 * or Send. Nothing is saved until then. groupId: the group screen it's on, if any.
 */
export function PlainEntry({ groupId }: { groupId?: string }) {
  const ai = useAi();
  const ledger = useLedger();
  const router = useRouter();
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<PlainDraft | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const read = async (work: () => ReturnType<typeof ai.parse>) => {
    setReading(true);
    setReadError(null);
    setDone(null);
    const r = await work();
    setReading(false);
    if (r.error) return setReadError(errorMessage(r.error));
    setDraft(r.draft ?? null);
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

  const finish = (message: string | null) => {
    setDraft(null);
    setText("");
    setDone(message);
  };

  return (
    <Card>
      <View style={styles.row}>
        <TextInput
          accessibilityLabel="Add an expense or a reminder in a sentence"
          style={styles.field}
          value={text}
          maxLength={500}
          onChangeText={setText}
          placeholder="petrol R600, split with Sam and Ana"
          placeholderTextColor={colors.faint}
          returnKeyType="go"
          onSubmitEditing={() => text.trim() && void read(() => ai.parse(text.trim(), groupId))}
        />
        <Button title="Go" busy={reading} disabled={!text.trim()} onPress={() => void read(() => ai.parse(text.trim(), groupId))} />
      </View>
      <Text style={styles.note}>Your sentence is sent to an AI model to read it: Google&apos;s Gemini, unless this Kitty server runs its own.</Text>
      <ErrorBanner message={readError ?? save.error ?? send.error} />
      {done && <Text style={styles.success}>{done}</Text>}
      {draft && (
        <DraftCard
          draft={draft}
          busy={reading || save.busy || send.busy}
          onPick={(i, memberId) => setDraft(applyPick(draft, i, memberId))}
          onPickGroup={(id) => void read(() => ai.resolve(draft.parsed, id))}
          onSave={() =>
            void save.run().then((r) => {
              if (!r.ok) return;
              const to = draft.groupId!;
              finish(null);
              router.push(`/groups/${to}`);
            })
          }
          onSend={() => void send.run().then((r) => r.ok && finish(`Reminder sent to ${draft.reminder?.name ?? "them"}.`))}
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
  onPick: (issueIndex: number, memberId: string | null) => void;
  onPickGroup: (groupId: string) => void;
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
        issue.field === "group" ? null : <IssuePicker key={`${issue.field}-${i}`} issue={issue} draft={draft} onPick={(m) => props.onPick(i, m)} />,
      )}

      <View style={styles.picks}>
        {draft.intent === "expense" && (
          <>
            <Button title="Save" disabled={busy || !canSave(draft)} onPress={props.onSave} />
            <Button title="Edit" variant="secondary" disabled={busy || !draft.groupId} onPress={props.onEdit} />
          </>
        )}
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
  success: { fontSize: font.sm, color: colors.owed },
  card: { gap: space.md, paddingTop: space.sm },
  summary: { gap: space.xs },
  title: { fontSize: font.base, fontWeight: "600", color: colors.text },
  text: { fontSize: font.base, color: colors.text },
  muted: { fontSize: font.sm, color: colors.muted },
  problem: { fontSize: font.sm, color: colors.owes },
  picks: { gap: space.sm },
});
