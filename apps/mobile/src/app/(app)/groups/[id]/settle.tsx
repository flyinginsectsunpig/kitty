import type { Schemas } from "@kitty/api-client";
import { allocateCovers, coverLines, coverNote, describeRate, draftMoney, errorMessage, type OpenItem } from "@kitty/core";
import { convertMinor, formatMoney, parseRate } from "@kitty/money";
import { randomUUID } from "expo-crypto";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { Button } from "../../../../components/Button";
import { Checkbox } from "../../../../components/Checkbox";
import { TextField } from "../../../../components/TextField";
import { CopyButton } from "../../../../components/CopyButton";
import { ErrorBanner } from "../../../../components/ErrorBanner";
import { GroupNav } from "../../../../components/GroupNav";
import { Card, LoadState, Screen } from "../../../../components/Screen";
import { useGroup } from "../../../../group/GroupContext";
import { useAction } from "../../../../hooks/useAction";
import { useFetchRate } from "../../../../hooks/useFetchRate";
import { useLoad } from "../../../../hooks/useLoad";
import { useLedger } from "../../../../ledger";
import { dayMonth } from "../../../../lib/day-month";
import { colors, font, radius, space } from "../../../../theme";

type Transfer = Schemas["TransferDto"] & { currency: string };

export default function SettleScreen() {
  const ledger = useLedger();
  const { group, me } = useGroup();
  const balances = useLoad(() => ledger.GET("/groups/{groupId}/balances", { params: { path: { groupId: group.id } } }), [ledger, group.id]);
  // Recent payments are extra: if they can't be loaded, the section is left out and the transfers still show.
  const payments = useLoad(
    () => ledger.GET("/groups/{groupId}/settlements", { params: { path: { groupId: group.id }, query: { limit: 20 } } }),
    [ledger, group.id],
  );
  const [notice, setNotice] = useState<string | null>(null);
  // Bumped once everything has loaded again, so each transfer's card (its open items and ticks) starts afresh.
  const [round, setRound] = useState(0);
  const refresh = () => void Promise.all([balances.reload(), payments.reload()]).then(() => setRound((r) => r + 1));
  const changed = (message: string) => {
    setNotice(message);
    refresh();
  };

  // Your own payments first, then ones you are owed, then everyone else's.
  const rank = (t: Transfer) => (t.fromMemberId === me.id ? 0 : t.toMemberId === me.id ? 1 : 2);

  return (
    <Screen onRefresh={refresh} refreshing={balances.loading && balances.data !== null}>
      <GroupNav groupId={group.id} active="/settle" />
      {notice && <Text style={styles.success}>{notice}</Text>}
      <LoadState state={balances}>
        {(b) => {
          const transfers = b.currencies.flatMap((c) => c.transfers.map((t) => ({ ...t, currency: c.currency }))).sort((x, y) => rank(x) - rank(y));
          return (
            <>
              {transfers.length === 0 ? (
                <Card>
                  <Text style={styles.center}>Everyone is settled up. 🎉</Text>
                </Card>
              ) : (
                <>
                  <Text style={styles.muted}>The fewest payments that settle everyone. Pay outside Kitty, then mark it as paid.</Text>
                  {transfers.map((t, i) => (
                    <View key={`${round}-${t.currency}-${t.fromMemberId}-${t.toMemberId}-${t.amountMinor}`} style={styles.stack}>
                      <TransferCard transfer={t} onPaid={() => changed("Payment recorded.")} />
                      {/* Someone who owes you: one Remind per person, under their first payment to you. */}
                      {t.toMemberId === me.id && transfers.findIndex((x) => x.toMemberId === me.id && x.fromMemberId === t.fromMemberId) === i && (
                        <RemindButton memberId={t.fromMemberId} />
                      )}
                    </View>
                  ))}
                </>
              )}
              {payments.data && payments.data.length > 0 && (
                <View style={styles.stack}>
                  <Text style={styles.heading}>Recent payments</Text>
                  {payments.data.map((line) => (
                    <PaymentRow key={line.payment.id} line={line} onDeleted={() => changed("Payment deleted.")} />
                  ))}
                </View>
              )}
            </>
          );
        }}
      </LoadState>
    </Screen>
  );
}

const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Reminds someone what they owe you (the ledger works out the amount; once a day). */
function RemindButton({ memberId }: { memberId: string }) {
  const ledger = useLedger();
  const { group, nameOf } = useGroup();
  const [sent, setSent] = useState(false);
  const remind = useAction(
    useCallback(
      (key: string) =>
        ledger.POST("/groups/{groupId}/reminders", {
          params: { path: { groupId: group.id } },
          body: { memberId },
          headers: { "Idempotency-Key": key },
        }),
      [ledger, group.id, memberId],
    ),
  );
  if (sent) return <Text style={styles.success}>Reminder sent to {nameOf(memberId)}.</Text>;
  return (
    <>
      <ErrorBanner message={remind.error} />
      <Button title={`Remind ${nameOf(memberId)}`} variant="secondary" busy={remind.busy} onPress={() => void remind.run().then((r) => r.ok && setSent(true))} />
    </>
  );
}

function TransferCard({ transfer: t, onPaid }: { transfer: Transfer; onPaid: () => void }) {
  const ledger = useLedger();
  const { group, me, nameOf } = useGroup();
  const id = useRef(randomUUID()).current; // one settlement per card, however many times it's retried
  const foreign = t.currency !== group.baseCurrency;
  const [inGroupCurrency, setInGroupCurrency] = useState(false);
  const [typedRate, setTypedRate] = useState("");
  const quote = useTodaysRate(foreign ? t.currency : null);
  const ecb = quote && quote !== "failed" ? quote : null;
  // The ledger couldn't look up a rate: ask for one.
  const [needsRate, setNeedsRate] = useState(false);
  const showRateBox = inGroupCurrency || quote === "failed" || needsRate;
  // A rate the person typed (only while its box is showing); paying in the group's currency otherwise sends the ECB rate
  // they were shown, so the amount stored is the amount they confirmed. Nothing sent: the ledger uses today's ECB rate.
  // Something typed that isn't a rate is sent as typed, so the ledger rejects it: never swapped for the ECB rate.
  const typed = showRateBox ? typedRate.trim() : "";
  const fxRate = typed ? (parseRate(typed) ?? typed) : foreign && inGroupCurrency ? ecb?.rate : undefined;
  const items = useOpenItems(t);
  // The ticks are kept as ticked, not read back from the covers: an item the amount doesn't reach stays ticked.
  const [ticked, setTicked] = useState<string[]>([]);
  const covers = useMemo(() => allocateCovers(items, ticked, t.amountMinor).covers, [items, ticked, t.amountMinor]);
  const pay = useAction(
    useCallback(
      (key: string) =>
        ledger.POST("/groups/{groupId}/settlements", {
          params: { path: { groupId: group.id } },
          body: {
            id, fromMemberId: t.fromMemberId, toMemberId: t.toMemberId, currency: t.currency, amountMinor: t.amountMinor,
            ...(fxRate ? { fxRate } : {}),
            paidInGroupCurrency: foreign && inGroupCurrency,
            // Nothing ticked: a payment not tied to an item, as before.
            ...(covers.length > 0 ? { covers } : {}),
          },
          headers: { "Idempotency-Key": key },
        }),
      [ledger, group.id, id, t, fxRate, foreign, inGroupCurrency, covers],
    ),
  );
  useEffect(() => {
    if (pay.error === errorMessage("fx_rate_required")) setNeedsRate(true);
  }, [pay.error]);
  const mine = t.fromMemberId === me.id;
  const from = mine ? "You" : nameOf(t.fromMemberId);
  const to = t.toMemberId === me.id ? "you" : nameOf(t.toMemberId);
  const details = group.members.find((m) => m.id === t.toMemberId)?.paymentDetails ?? null;

  return (
    <Card>
      <Text style={styles.line}>
        <Text style={styles.strong}>{from}</Text> {mine ? "pay" : "pays"} <Text style={styles.strong}>{to}</Text>{" "}
        <Text style={styles.strong}>{formatMoney(t.amountMinor, t.currency)}</Text>
      </Text>
      {t.toMemberId !== me.id &&
        (details ? (
          <View style={styles.details}>
            <Text style={styles.detailsText} selectable>
              {details}
            </Text>
            <CopyButton text={details} />
          </View>
        ) : (
          <Text style={styles.small}>{nameOf(t.toMemberId)} hasn't added payment details yet.</Text>
        ))}
      {foreign && (
        <ForeignFields transfer={t} groupCurrency={group.baseCurrency} quote={quote} inGroupCurrency={inGroupCurrency}
          onInGroupCurrency={setInGroupCurrency} typedRate={typedRate} onTypedRate={setTypedRate} showRateBox={showRateBox}
        />
      )}
      {items.length > 0 && (
        <CoversPicker items={items} ticked={ticked} onTicked={setTicked} covers={covers} currency={t.currency} />
      )}
      <ErrorBanner message={pay.error} />
      <Button title="Mark as paid" busy={pay.busy} onPress={() => void pay.run().then((r) => r.ok && onPaid())} />
    </Card>
  );
}

/**
 * What the payer still owes the receiver item by item, in the transfer's currency, for the ticks. Empty while
 * loading and when the ledger can't list them: the ticks are optional, and the transfer is marked as paid without.
 */
function useOpenItems(t: Transfer): OpenItem[] {
  const ledger = useLedger();
  const { group } = useGroup();
  const [items, setItems] = useState<OpenItem[]>([]);
  const { fromMemberId: from, toMemberId: to, currency } = t;
  useEffect(() => {
    let live = true;
    ledger
      .GET("/groups/{groupId}/open-items", { params: { path: { groupId: group.id }, query: { from, to } } })
      .then((r) => {
        const open = r.data?.currencies.find((c) => c.currency === currency)?.fromOwes ?? [];
        if (live)
          setItems(open.map((o) => ({ expenseId: o.item.expenseId, description: o.item.description, date: o.item.date, openMinor: o.open.minor })));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ledger, group.id, from, to, currency]);
  return items;
}

/** "What it covers": the open items, none ticked at first; the payment is spread over the ticked ones, oldest first. */
function CoversPicker({ items, ticked, onTicked, covers, currency }: {
  items: OpenItem[];
  ticked: string[];
  onTicked: (ticked: string[]) => void;
  covers: { expenseId: string; amountMinor: number }[];
  currency: string;
}) {
  const [open, setOpen] = useState(false);
  // Before saving, say what a ticked item doesn't get: part of what's open, or nothing once the payment runs out.
  const notes = coverLines(items, ticked, covers)
    .map((l) => ({ id: l.expenseId, text: coverNote(l, currency) }))
    .filter((n) => n.text !== null);
  const toggle = (id: string) => onTicked(ticked.includes(id) ? ticked.filter((x) => x !== id) : [...ticked, id]);
  return (
    <View style={styles.foreign}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={styles.toggle} hitSlop={6}>
        <Text style={styles.muted}>{open ? "▾" : "▸"}</Text>
        <Text style={styles.muted}>What it covers</Text>
      </Pressable>
      {open && (
        <>
          {items.map((i) => (
            <Checkbox
              key={i.expenseId}
              label={`${i.description} · ${dayMonth(i.date)} · ${draftMoney(i.openMinor, currency)} open`}
              checked={ticked.includes(i.expenseId)}
              onChange={() => toggle(i.expenseId)}
            />
          ))}
          {notes.map((n) => (
            <Text key={n.id} style={styles.muted}>
              {n.text}
            </Text>
          ))}
        </>
      )}
    </View>
  );
}

/** One of Recent payments, with Delete: the items it covered go back on the list. */
function PaymentRow({ line: r, onDeleted }: { line: Schemas["SettlementLineDto"]; onDeleted: () => void }) {
  const ledger = useLedger();
  const { group, me } = useGroup();
  const p = r.payment;
  const remove = useAction(
    useCallback(
      (key: string) =>
        ledger.DELETE("/groups/{groupId}/settlements/{settlementId}", {
          params: { path: { groupId: group.id, settlementId: p.id } },
          headers: { "Idempotency-Key": key },
        }),
      [ledger, group.id, p.id],
    ),
  );
  const from = p.fromMemberId === me.id ? "You" : r.from;
  const to = p.toMemberId === me.id ? "you" : r.to;
  const what = r.covers.map((c) => c.description).join(", ");
  const money = formatMoney(p.amountMinor, p.currency);
  const confirmDelete = () =>
    Alert.alert("Delete this payment?", "Its items go back on the list.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void remove.run().then((done) => done.ok && onDeleted()) },
    ]);
  return (
    <Card>
      <View style={styles.paymentRow}>
        <Text style={[styles.line, styles.grow]}>{`${from} paid ${to} ${money} · ${dayMonth(r.date)}${what ? ` · for: ${what}` : ""}`}</Text>
        <Button title="Delete" variant="secondary" busy={remove.busy} accessibilityLabel={`Delete payment: ${from} paid ${to} ${money}`} onPress={confirmDelete} />
      </View>
      <ErrorBanner message={remove.error} />
    </Card>
  );
}

/**
 * Settling a debt in another currency: today's ECB rate, the option to pay in the group's currency, and a rate box —
 * shown when paying in the group's currency, when the ECB rate couldn't be fetched, or after the ledger asked for one.
 */
type Quote = { rate: string; rateDate: string } | "failed" | null;

/** Today's ECB rate for a currency (null while loading, or when currency is null). */
function useTodaysRate(currency: string | null): Quote {
  const { group } = useGroup();
  const fetchRate = useFetchRate(group.id);
  const [quote, setQuote] = useState<Quote>(null);
  useEffect(() => {
    if (!currency) return;
    let live = true;
    fetchRate(currency, todayUtc())
      .then((q) => live && setQuote(q ?? "failed"))
      .catch(() => live && setQuote("failed"));
    return () => {
      live = false;
    };
  }, [fetchRate, currency]);
  return quote;
}

function ForeignFields({ transfer: t, groupCurrency, quote, inGroupCurrency, onInGroupCurrency, typedRate, onTypedRate, showRateBox }: {
  transfer: Transfer;
  groupCurrency: string;
  quote: Quote;
  inGroupCurrency: boolean;
  onInGroupCurrency: (value: boolean) => void;
  typedRate: string;
  onTypedRate: (value: string) => void;
  showRateBox: boolean;
}) {
  const ecb = quote && quote !== "failed" ? quote : null;
  const rate = parseRate(typedRate.trim()) ?? ecb?.rate ?? null;
  return (
    <View style={styles.foreign}>
      <Text style={styles.muted}>
        {ecb ? describeRate({ from: t.currency, to: groupCurrency, rate: ecb.rate, rateDate: ecb.rateDate, source: "ecb" })
          : quote === "failed" ? "Couldn't get today's ECB rate. Enter the rate you used."
          : "Getting today's rate…"}
      </Text>
      <Checkbox label={`Pay in ${groupCurrency} instead`} checked={inGroupCurrency} onChange={onInGroupCurrency} />
      {inGroupCurrency && rate && (
        <Text style={styles.strong}>{`Pay ${formatMoney(convertMinor(t.amountMinor, rate, t.currency, groupCurrency), groupCurrency)}`}</Text>
      )}
      {showRateBox && (
        <TextField label={`Rate (1 ${t.currency} in ${groupCurrency})`} value={typedRate} onChangeText={onTypedRate}
          keyboardType="decimal-pad" placeholder={ecb?.rate ?? "e.g. 19.5"} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.sm },
  heading: { fontSize: font.base, fontWeight: "600", color: colors.text },
  toggle: { flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 32 },
  paymentRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  grow: { flex: 1 },
  foreign: { gap: space.xs },
  line: { fontSize: font.base, color: colors.text },
  strong: { fontWeight: "600" },
  details: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  detailsText: { flex: 1, fontSize: font.sm, color: colors.text, backgroundColor: "#f5f5f4", borderRadius: 8, padding: space.sm },
  small: { fontSize: 12, color: colors.muted },
  muted: { fontSize: font.sm, color: colors.muted },
  center: { fontSize: font.base, color: colors.muted, textAlign: "center" },
  success: { fontSize: font.sm, color: colors.owed, backgroundColor: "#f0fdf4", borderRadius: radius.field, padding: space.md },
});
