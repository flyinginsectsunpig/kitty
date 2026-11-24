import type { Schemas } from "@kitty/api-client";
import { describeRate, errorMessage } from "@kitty/core";
import { convertMinor, formatMoney, parseRate } from "@kitty/money";
import { randomUUID } from "expo-crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
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

const todayUtc = () => new Date().toISOString().slice(0, 10);

function TransferCard({ transfer: t, onPaid }: { transfer: Transfer; onPaid: () => void }) {
  const ledger = useLedger();
  const { group, me, nameOf } = useGroup();
  const id = useRef(randomUUID()).current; // one settlement per card, however many times it's retried
  const foreign = t.currency !== group.baseCurrency;
  const [inGroupCurrency, setInGroupCurrency] = useState(false);
  const [typedRate, setTypedRate] = useState("");
  const fxRate = parseRate(typedRate.trim()) ?? undefined; // sent only when typed; otherwise the ledger uses today's ECB rate
  const pay = useAction(
    useCallback(
      (key: string) =>
        ledger.POST("/groups/{groupId}/settlements", {
          params: { path: { groupId: group.id } },
          body: {
            id, fromMemberId: t.fromMemberId, toMemberId: t.toMemberId, currency: t.currency, amountMinor: t.amountMinor,
            ...(fxRate ? { fxRate } : {}),
            paidInGroupCurrency: foreign && inGroupCurrency,
          },
          headers: { "Idempotency-Key": key },
        }),
      [ledger, group.id, id, t, fxRate, foreign, inGroupCurrency],
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
      {foreign && (
        <ForeignFields transfer={t} groupCurrency={group.baseCurrency} inGroupCurrency={inGroupCurrency}
          onInGroupCurrency={setInGroupCurrency} typedRate={typedRate} onTypedRate={setTypedRate}
          // The ledger couldn't look up a rate: ask for one.
          needsRate={pay.error === errorMessage("fx_rate_required")} />
      )}
      <ErrorBanner message={pay.error} />
      <Button title="Mark as paid" busy={pay.busy} onPress={() => void pay.run().then((r) => r.ok && onPaid())} />
    </Card>
  );
}


/**
 * Settling a debt in another currency: today's ECB rate, the option to pay in the group's currency, and a rate box —
 * shown when paying in the group's currency, when the ECB rate couldn't be fetched, or after the ledger asked for one.
 */
function ForeignFields({ transfer: t, groupCurrency, inGroupCurrency, onInGroupCurrency, typedRate, onTypedRate, needsRate }: {
  transfer: Transfer;
  groupCurrency: string;
  inGroupCurrency: boolean;
  onInGroupCurrency: (value: boolean) => void;
  typedRate: string;
  onTypedRate: (value: string) => void;
  needsRate: boolean;
}) {
  const { group } = useGroup();
  const fetchRate = useFetchRate(group.id);
  const [quote, setQuote] = useState<{ rate: string; rateDate: string } | "failed" | null>(null);

  useEffect(() => {
    let live = true;
    fetchRate(t.currency, todayUtc())
      .then((q) => live && setQuote(q ?? "failed"))
      .catch(() => live && setQuote("failed"));
    return () => {
      live = false;
    };
  }, [fetchRate, t.currency]);

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
      {(inGroupCurrency || quote === "failed" || needsRate) && (
        <TextField label={`Rate (1 ${t.currency} in ${groupCurrency})`} value={typedRate} onChangeText={onTypedRate}
          keyboardType="decimal-pad" placeholder={ecb?.rate ?? "e.g. 19.5"} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
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
