import type { LedgerProblem } from "@kitty/api-client";
import { errorMessage, rowsAction, tipToMinor, type TableSession } from "@kitty/core";
import { exponent, formatMoney, parseMoney, toDecimalString } from "@kitty/money";
import { randomUUID } from "expo-crypto";
import { useRouter } from "expo-router";
import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useGroup } from "../../group/GroupContext";
import type { LedgerResult } from "../../hooks/useAction";
import { useTableSession } from "../../hooks/useTableSession";
import { useLedger } from "../../ledger";
import { colors, font, radius, space } from "../../theme";
import { Button } from "../Button";
import { Chips } from "../Chips";
import { ErrorBanner } from "../ErrorBanner";
import { Card, Screen } from "../Screen";
import { ItemList, PreviewTotals } from "./ItemList";
import { JoinQr } from "./JoinQr";

type Row = { id: string; description: string; quantity: string; amount: string };

/**
 * The host's screen (web's HostTable, natively): enter the bill, show the QR code, watch claims arrive, match guests,
 * confirm. `scan` is the receipt-scan block, shown while the bill is open.
 */
export function HostTable({ initial, groupId, scan }: { initial: TableSession; groupId: string; scan?: (run: Run) => ReactNode }) {
  const ledger = useLedger();
  const router = useRouter();
  const { group, reload: reloadGroup } = useGroup();
  const { session, apply, refresh } = useTableSession(initial, groupId);
  const exp = exponent(session.currency);
  const money = (minor: number) => formatMoney(minor, session.currency);
  const toRows = (items: TableSession["items"]): Row[] =>
    items.map((i) => ({ id: i.id, description: i.description, quantity: String(i.quantity), amount: toDecimalString(i.lineTotalMinor, exp) }));
  const [rows, setRows] = useState<Row[]>(() => toRows(initial.items));
  const [tipMode, setTipMode] = useState<"percent" | "amount">("percent");
  const [tipInput, setTipInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const me = session.viewer.id;
  const open = session.status === "open";
  const active = open || session.status === "locked";
  const itemsTotal = session.items.reduce((sum, i) => sum + i.lineTotalMinor, 0);
  const chargesTotal = session.charges.reduce((sum, c) => sum + c.amountMinor, 0);
  const unclaimed = session.items.filter((i) => i.claimants.length === 0);
  const unmatchedGuests = session.guests.filter((g) => !g.mappedMemberId && session.items.some((i) => i.claimants.some((c) => c.id === g.id)));
  const path = { params: { path: { groupId, sessionId: session.id } } };

  // What "Save items" would send, and whether it differs from what the table already has.
  const typed = rows
    .filter((r) => r.description.trim() || r.amount.trim())
    .map((r) => ({ id: r.id, description: r.description.trim(), quantity: Number(r.quantity) || 1, lineTotalMinor: parseMoney(r.amount, session.currency) ?? -1 }));
  // When the bill's items change elsewhere (a scan filled them), the rows follow, unless the host is editing.
  const itemsKey = JSON.stringify(session.items.map((i) => [i.id, i.description, i.quantity, i.lineTotalMinor]));
  const rowsKey = JSON.stringify(typed.map((i) => [i.id, i.description, i.quantity, i.lineTotalMinor]));
  const [rowsBuiltFrom, setRowsBuiltFrom] = useState(itemsKey);
  if (itemsKey !== rowsBuiltFrom) {
    if (rowsAction(rowsKey, rowsBuiltFrom, itemsKey) === "reset") setRows(toRows(session.items));
    setRowsBuiltFrom(itemsKey);
  }
  const unsaved =
    typed.length !== session.items.length ||
    typed.some((t, i) => {
      const saved = session.items[i];
      return !saved || saved.id !== t.id || saved.description !== t.description || saved.quantity !== t.quantity || saved.lineTotalMinor !== t.lineTotalMinor;
    });

  /** Runs one host action. Never throws and always clears `busy`: a dropped connection is the "network" error. */
  async function run(action: () => Promise<LedgerResult<TableSession> | LedgerResult<unknown>>): Promise<TableSession | null> {
    setBusy(true);
    setError(null);
    try {
      const r = await action();
      if (!r.response.ok) {
        setError(errorMessage((r.error as LedgerProblem | undefined)?.code ?? "unexpected"));
        return null;
      }
      const next = (r.data as TableSession | undefined) ?? null;
      if (next && "items" in next) apply(next);
      else refresh();
      return next;
    } catch {
      setError(errorMessage("network"));
      return null;
    } finally {
      setBusy(false);
    }
  }

  function onSaveItems() {
    if (typed.some((i) => !i.description || i.lineTotalMinor < 0 || i.quantity < 1 || i.quantity > 99))
      return setError("Each item needs a name, a quantity from 1 to 99 and a valid price.");
    void run(() => ledger.PUT("/groups/{groupId}/table-sessions/{sessionId}/items", { ...path, body: { items: typed } }));
  }

  function onSaveTip() {
    const tip = tipToMinor(tipInput, tipMode, itemsTotal, session.currency);
    if (tip === null) return setError("Enter the tip as an amount or a percentage (0–100).");
    const charges = tip > 0 ? [{ id: randomUUID(), kind: "tip", amountMinor: tip }] : [];
    void run(() => ledger.PUT("/groups/{groupId}/table-sessions/{sessionId}/charges", { ...path, body: { charges } }));
  }

  async function onMapGuest(guestId: string, guestName: string, memberId: string | null) {
    let target = memberId;
    if (target === null) {
      // "Add them to the group": a placeholder they can take over later, then match the guest to it.
      try {
        const added = await ledger.POST("/groups/{groupId}/members", { params: { path: { groupId } }, body: { displayName: guestName } });
        if (!added.data) return setError(errorMessage((added.error as LedgerProblem | undefined)?.code ?? "unexpected"));
        target = added.data.id;
        void reloadGroup();
      } catch {
        return setError(errorMessage("network"));
      }
    }
    await run(() =>
      ledger.POST("/groups/{groupId}/table-sessions/{sessionId}/guests/{guestId}/map", { params: { path: { groupId, sessionId: session.id, guestId } }, body: { memberId: target } }),
    );
  }

  async function onConfirm() {
    const done = await run(() => ledger.POST("/groups/{groupId}/table-sessions/{sessionId}/confirm", path));
    if (done?.expenseId) router.dismissTo(`/groups/${groupId}`);
  }

  const setRow = (id: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const transition = (to: "lock" | "unlock" | "cancel") =>
    void run(() =>
      to === "lock"
        ? ledger.POST("/groups/{groupId}/table-sessions/{sessionId}/lock", path)
        : to === "unlock"
          ? ledger.POST("/groups/{groupId}/table-sessions/{sessionId}/unlock", path)
          : ledger.POST("/groups/{groupId}/table-sessions/{sessionId}/cancel", path),
    );
  const claim = (itemId: string, claimed: boolean) => {
    const options = { params: { path: { groupId, sessionId: session.id, itemId } } };
    void run(() =>
      claimed
        ? ledger.PUT("/groups/{groupId}/table-sessions/{sessionId}/items/{itemId}/claim", options)
        : ledger.DELETE("/groups/{groupId}/table-sessions/{sessionId}/items/{itemId}/claim", options),
    );
  };

  return (
    <Screen>
      <Text style={styles.kicker}>You're running this table</Text>
      <Text style={styles.title}>{session.title}</Text>
      <Text style={styles.muted}>
        Items {money(itemsTotal)} · extras {money(chargesTotal)} · total <Text style={styles.strong}>{money(itemsTotal + chargesTotal)}</Text>
      </Text>

      {session.status === "confirmed" && <Text style={[styles.status, styles.done]}>This bill has been split and added to the group.</Text>}
      {session.status === "cancelled" && <Text style={styles.status}>This bill was cancelled. Nothing was recorded.</Text>}
      <ErrorBanner message={error} />

      {open && scan?.(run)}

      <Card>
        <Text style={styles.h2}>1. The bill</Text>
        <Text style={styles.small}>Prices as printed (VAT is already included in South Africa). Add tip or service charge below.</Text>
        {rows.map((r, i) => (
          <View key={r.id} style={styles.itemRow}>
            <TextInput accessibilityLabel={`Item ${i + 1} quantity`} keyboardType="number-pad" style={[styles.field, styles.qty]} value={r.quantity} editable={open} onChangeText={(quantity) => setRow(r.id, { quantity })} />
            <TextInput accessibilityLabel={`Item ${i + 1} name`} placeholder="Burger" placeholderTextColor={colors.faint} maxLength={80} style={[styles.field, styles.grow]} value={r.description} editable={open} onChangeText={(description) => setRow(r.id, { description })} />
            <TextInput accessibilityLabel={`Item ${i + 1} price`} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={colors.faint} style={[styles.field, styles.price]} value={r.amount} editable={open} onChangeText={(amount) => setRow(r.id, { amount })} />
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove item ${i + 1}`} disabled={!open} hitSlop={8} onPress={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}>
              <Text style={styles.remove}>×</Text>
            </Pressable>
          </View>
        ))}
        <View style={styles.pair}>
          <View style={styles.grow}>
            <Button title="Add item" variant="secondary" disabled={!open} onPress={() => setRows((rs) => [...rs, { id: randomUUID(), description: "", quantity: "1", amount: "" }])} />
          </View>
          <View style={styles.grow}>
            <Button title={unsaved ? "Save items" : "Items saved"} variant={unsaved ? "primary" : "secondary"} disabled={!open || busy || !unsaved} onPress={onSaveItems} />
          </View>
        </View>
        <View style={styles.tip}>
          <View style={styles.grow}>
            <Text style={styles.label}>Tip</Text>
            <TextInput accessibilityLabel="Tip" keyboardType="decimal-pad" placeholder={tipMode === "percent" ? "10" : "50.00"} placeholderTextColor={colors.faint} style={styles.field} value={tipInput} editable={open} onChangeText={setTipInput} />
          </View>
          <Chips label="Tip as" options={["percent", "amount"] as const} value={tipMode} onChange={setTipMode} render={(m) => (m === "percent" ? "%" : session.currency)} />
        </View>
        <Button title="Set tip" variant="secondary" disabled={!open || busy} onPress={onSaveTip} />
      </Card>

      {active && <JoinQr sessionId={session.id} groupId={groupId} />}

      <Text style={styles.h2}>Live claims</Text>
      <ItemList session={session} meId={me} onToggle={open ? claim : undefined} />
      {session.preview.length > 0 && (
        <>
          <Text style={styles.h3}>{active ? "If you confirm now" : "The split"}</Text>
          <PreviewTotals session={session} meId={me} />
        </>
      )}
      {active && session.preview.length > 0 && unclaimed.length > 0 && (
        <Text style={styles.muted}>
          {unclaimed.length === 1 ? "1 item hasn't" : `${unclaimed.length} items haven't`} been claimed ({money(unclaimed.reduce((sum, i) => sum + i.lineTotalMinor, 0))}).
          Unclaimed items are split between everyone who tapped something.
        </Text>
      )}

      {active && session.guests.length > 0 && (
        <Card>
          <Text style={styles.h2}>3. Who are the guests?</Text>
          <Text style={styles.small}>Match each guest to someone in the group (or add them) so their share lands on the right person.</Text>
          {session.guests.map((g) => (
            <View key={g.id} style={styles.guest}>
              <Text style={styles.strong}>{g.displayName}</Text>
              <View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel={`Who is ${g.displayName}?`}>
                {group.members.map((m) => (
                  <Choice key={m.id} label={`${g.displayName} is ${m.displayName}`} text={m.displayName} selected={g.mappedMemberId === m.id} disabled={busy} onPress={() => void onMapGuest(g.id, g.displayName, m.id)} />
                ))}
                <Choice label={`Add ${g.displayName} to the group`} text={`Add “${g.displayName}”`} selected={false} disabled={busy} onPress={() => void onMapGuest(g.id, g.displayName, null)} />
              </View>
            </View>
          ))}
        </Card>
      )}

      {active && (
        <View style={styles.actions}>
          {session.preview.length === 0 && <Text style={styles.muted}>Nobody has tapped anything yet, so there is nothing to split.</Text>}
          {unmatchedGuests.length > 0 && <Text style={styles.muted}>Match {unmatchedGuests.map((g) => g.displayName).join(", ")} to someone in the group before confirming.</Text>}
          <View style={styles.pair}>
            <View style={styles.grow}>
              {open ? (
                <Button title="Lock the bill" variant="secondary" disabled={busy} onPress={() => transition("lock")} />
              ) : (
                <Button title="Unlock" variant="secondary" disabled={busy} onPress={() => transition("unlock")} />
              )}
            </View>
            <View style={styles.grow}>
              <Button title="Confirm and split" disabled={busy || session.preview.length === 0 || unmatchedGuests.length > 0} onPress={() => void onConfirm()} />
            </View>
          </View>
          <Button title="Cancel this bill" variant="danger" disabled={busy} onPress={() => transition("cancel")} />
        </View>
      )}
    </Screen>
  );
}

export type Run = (action: () => Promise<LedgerResult<TableSession> | LedgerResult<unknown>>) => Promise<TableSession | null>;

function Choice({ label, text, selected, disabled, onPress }: { label: string; text: string; selected: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} style={[styles.choice, selected && styles.choiceOn]}>
      <Text style={[styles.choiceText, selected && styles.choiceTextOn]}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  kicker: { fontSize: font.sm, color: colors.muted, textTransform: "uppercase", letterSpacing: 1 },
  title: { fontSize: font.xl, fontWeight: "700", color: colors.text },
  h2: { fontSize: font.base, fontWeight: "600", color: colors.text },
  h3: { fontSize: font.sm, fontWeight: "600", color: colors.text },
  label: { fontSize: font.sm, fontWeight: "500", color: colors.muted, marginBottom: space.xs },
  strong: { fontWeight: "600", color: colors.text },
  muted: { fontSize: font.sm, color: colors.muted },
  small: { fontSize: 12, color: colors.muted },
  status: { borderRadius: radius.field, padding: space.md, backgroundColor: "#f5f5f4", fontSize: font.sm, color: colors.text },
  done: { backgroundColor: "#f0fdf4", color: colors.owed },
  itemRow: { flexDirection: "row", alignItems: "center", gap: space.xs },
  field: { minHeight: 44, borderWidth: 1, borderColor: colors.fieldBorder, borderRadius: radius.field, paddingHorizontal: space.sm, fontSize: font.base, color: colors.text, backgroundColor: colors.card },
  qty: { width: 48, textAlign: "center" },
  price: { width: 92, textAlign: "right" },
  grow: { flex: 1 },
  remove: { fontSize: 22, color: colors.faint, paddingHorizontal: space.xs },
  pair: { flexDirection: "row", gap: space.sm },
  tip: { gap: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingTop: space.md },
  actions: { gap: space.sm },
  guest: { gap: space.xs, paddingVertical: space.xs },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  choice: { minHeight: 36, paddingHorizontal: space.md, justifyContent: "center", borderRadius: 999, borderWidth: 1, borderColor: colors.fieldBorder, backgroundColor: colors.card },
  choiceOn: { backgroundColor: colors.brand600, borderColor: colors.brand600 },
  choiceText: { fontSize: font.sm, color: colors.text },
  choiceTextOn: { color: "#fff", fontWeight: "600" },
});
