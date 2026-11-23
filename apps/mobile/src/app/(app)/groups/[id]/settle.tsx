import type { Schemas } from "@kitty/api-client";
import { formatMoney } from "@kitty/money";
import { randomUUID } from "expo-crypto";
import { useCallback, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Button } from "../../../../components/Button";
import { CopyButton } from "../../../../components/CopyButton";
import { ErrorBanner } from "../../../../components/ErrorBanner";
import { GroupNav } from "../../../../components/GroupNav";
import { Card, LoadState, Screen } from "../../../../components/Screen";
import { useGroup } from "../../../../group/GroupContext";
import { useAction } from "../../../../hooks/useAction";
import { useLoad } from "../../../../hooks/useLoad";
import { useLedger } from "../../../../ledger";
import { colors, font, radius, space } from "../../../../theme";

type Transfer = Schemas["TransferDto"] & { currency: string };

export default function SettleScreen() {
  const ledger = useLedger();
  const { group, me } = useGroup();
  const balances = useLoad(() => ledger.GET("/groups/{groupId}/balances", { params: { path: { groupId: group.id } } }), [ledger, group.id]);
  const [recorded, setRecorded] = useState(false);

  // Your own payments first, then ones you are owed, then everyone else's.
  const rank = (t: Transfer) => (t.fromMemberId === me.id ? 0 : t.toMemberId === me.id ? 1 : 2);

  return (
    <Screen onRefresh={() => void balances.reload()} refreshing={balances.loading && balances.data !== null}>
      <GroupNav groupId={group.id} active="/settle" />
      {recorded && <Text style={styles.success}>Payment recorded.</Text>}
      <LoadState state={balances}>
        {(b) => {
          const transfers = b.currencies.flatMap((c) => c.transfers.map((t) => ({ ...t, currency: c.currency }))).sort((x, y) => rank(x) - rank(y));
          if (transfers.length === 0)
            return (
              <Card>
                <Text style={styles.center}>Everyone is settled up. 🎉</Text>
              </Card>
            );
          return (
            <>
              <Text style={styles.muted}>The fewest payments that settle everyone. Pay outside Kitty, then mark it as paid.</Text>
              {transfers.map((t) => (
                <TransferCard
                  key={`${t.currency}-${t.fromMemberId}-${t.toMemberId}-${t.amountMinor}`}
                  transfer={t}
                  onPaid={() => {
                    setRecorded(true);
                    void balances.reload();
                  }}
                />
              ))}
            </>
          );
        }}
      </LoadState>
    </Screen>
  );
}

function TransferCard({ transfer: t, onPaid }: { transfer: Transfer; onPaid: () => void }) {
  const ledger = useLedger();
  const { group, me, nameOf } = useGroup();
  const id = useRef(randomUUID()).current; // one settlement per card, however many times it's retried
  const pay = useAction(
    useCallback(
      (key: string) =>
        ledger.POST("/groups/{groupId}/settlements", {
          params: { path: { groupId: group.id } },
          body: { id, fromMemberId: t.fromMemberId, toMemberId: t.toMemberId, currency: t.currency, amountMinor: t.amountMinor },
          headers: { "Idempotency-Key": key },
        }),
      [ledger, group.id, id, t],
    ),
  );
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
      <ErrorBanner message={pay.error} />
      <Button title="Mark as paid" busy={pay.busy} onPress={() => void pay.run().then((r) => r.ok && onPaid())} />
    </Card>
  );
}

const styles = StyleSheet.create({
  line: { fontSize: font.base, color: colors.text },
  strong: { fontWeight: "600" },
  details: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  detailsText: { flex: 1, fontSize: font.sm, color: colors.text, backgroundColor: "#f5f5f4", borderRadius: 8, padding: space.sm },
  small: { fontSize: 12, color: colors.muted },
  muted: { fontSize: font.sm, color: colors.muted },
  center: { fontSize: font.base, color: colors.muted, textAlign: "center" },
  success: { fontSize: font.sm, color: colors.owed, backgroundColor: "#f0fdf4", borderRadius: radius.field, padding: space.md },
});
