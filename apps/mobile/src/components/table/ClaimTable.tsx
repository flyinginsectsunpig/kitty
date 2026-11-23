import { errorMessage, myShare, type TableSession } from "@kitty/core";
import { formatMoney } from "@kitty/money";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLedger } from "../../ledger";
import { useTableSession } from "../../hooks/useTableSession";
import { colors, font, radius, space } from "../../theme";
import { ErrorBanner } from "../ErrorBanner";
import { Screen } from "../Screen";
import { ItemList, PreviewTotals } from "./ItemList";

type Phase = "open" | "locked" | "settled" | "cancelled" | "closed";

/** The screen everyone at the table uses: tap what you had, watch everyone else's taps arrive live. */
export function ClaimTable({ initial, groupId }: { initial: TableSession; groupId: string }) {
  const ledger = useLedger();
  const { session, closed, refresh } = useTableSession(initial, groupId);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const me = session.viewer.id;
  const payer = session.payerDisplayName;
  const money = (minor: number) => formatMoney(minor, session.currency);

  const phase: Phase = closed
    ? closed.how === "confirmed" ? "settled" : closed.how === "cancelled" ? "cancelled" : "closed"
    : session.status === "confirmed" ? "settled"
      : session.status === "cancelled" ? "cancelled"
        : session.status === "locked" ? "locked" : "open";

  const soFar = myShare(session);
  const lastSplit = session.preview.find((p) => p.id === me)?.amountMinor ?? 0;
  const finalAmount = (phase === "locked" || phase === "settled") && (closed === null || closed.finalKnown) ? lastSplit : null;

  async function onToggle(itemId: string, claim: boolean) {
    setBusy(itemId);
    setError(null);
    const options = { params: { path: { groupId, sessionId: session.id, itemId } } };
    try {
      const r = claim
        ? await ledger.PUT("/groups/{groupId}/table-sessions/{sessionId}/items/{itemId}/claim", options)
        : await ledger.DELETE("/groups/{groupId}/table-sessions/{sessionId}/items/{itemId}/claim", options);
      if (!r.response.ok) setError(errorMessage((r.error as { code?: string } | undefined)?.code ?? "unexpected"));
    } catch {
      setError(errorMessage("network"));
    } finally {
      setBusy(null);
      refresh();
    }
  }

  return (
    <View style={styles.page}>
      <Screen>
        <Text style={styles.kicker}>Splitting the bill</Text>
        <Text style={styles.title}>{session.title}</Text>

        {phase === "settled" && (
          <View accessibilityRole="summary" style={[styles.status, styles.done]}>
            <Text style={styles.doneTitle}>Done. The bill has been split.</Text>
            <Text style={styles.doneText}>
              {finalAmount === null
                ? `Ask ${payer} for your final amount.`
                : session.payerMemberId === me
                  ? "You paid the bill. Everyone else now owes you their share."
                  : finalAmount === 0
                    ? "You don't owe anything for this bill."
                    : `Your share is ${money(finalAmount)}. Pay ${payer}.`}
            </Text>
          </View>
        )}
        {phase === "cancelled" && <Text style={styles.status}>The host cancelled this bill. Nothing was recorded.</Text>}
        {phase === "closed" && <Text style={styles.status}>This bill is closed. Ask {payer} if you still owe anything.</Text>}
        {phase === "locked" && <Text style={[styles.status, styles.locked]}>The host has locked the bill and is about to confirm it.</Text>}
        <ErrorBanner message={error} />

        {phase === "open" && <Text style={styles.muted}>Tap everything you had. Tap again to undo.</Text>}
        <ItemList session={session} meId={me} onToggle={phase === "open" ? (id, c) => void onToggle(id, c) : undefined} busyItemId={busy} />

        {phase === "open" && soFar.unclaimedMinor > 0 && (
          <Text style={styles.muted}>
            {money(soFar.unclaimedMinor)} hasn't been claimed yet. Whatever is still unclaimed when the host confirms is split between everyone who tapped
            something.
          </Text>
        )}

        {finalAmount !== null && session.preview.length > 0 && (
          <>
            <Text style={styles.h2}>The split</Text>
            <PreviewTotals session={session} meId={me} />
          </>
        )}
      </Screen>
      {(phase === "open" || finalAmount !== null) && (
        <View style={styles.bar}>
          <Text style={styles.muted}>{phase === "open" ? "Your share so far" : "Your share"}</Text>
          <Text style={styles.total}>{money(finalAmount ?? soFar.minor)}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  kicker: { fontSize: font.sm, color: colors.muted, textTransform: "uppercase", letterSpacing: 1 },
  title: { fontSize: font.xl, fontWeight: "700", color: colors.text },
  h2: { fontSize: font.lg, fontWeight: "600", color: colors.text },
  status: { borderRadius: radius.field, padding: space.md, backgroundColor: "#f5f5f4", fontSize: font.sm, color: colors.text },
  done: { backgroundColor: "#f0fdf4", gap: space.xs },
  doneTitle: { fontSize: font.sm, fontWeight: "600", color: colors.owed },
  doneText: { fontSize: font.sm, color: colors.owed },
  locked: { backgroundColor: "#fffbeb" },
  muted: { fontSize: font.sm, color: colors.muted },
  bar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.lg, paddingVertical: space.md, borderTopWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  total: { fontSize: font.xl, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"] },
});
