import { supportedCurrencies } from "@kitty/money";
import { randomUUID } from "expo-crypto";
import { Stack, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { StyleSheet, Text } from "react-native";
import { Button } from "../../../../../components/Button";
import { Chips } from "../../../../../components/Chips";
import { ErrorBanner } from "../../../../../components/ErrorBanner";
import { Card, Screen } from "../../../../../components/Screen";
import { TextField } from "../../../../../components/TextField";
import { useGroup } from "../../../../../group/GroupContext";
import { useAction } from "../../../../../hooks/useAction";
import { useLedger } from "../../../../../ledger";
import { colors, font } from "../../../../../theme";

export default function NewTableScreen() {
  const ledger = useLedger();
  const router = useRouter();
  const { group, me, nameOf } = useGroup();
  const id = useRef(randomUUID()).current;
  const [title, setTitle] = useState("");
  const [payerMemberId, setPayer] = useState(me.id);
  const [currency, setCurrency] = useState(group.baseCurrency);
  const start = useAction(
    useCallback(
      (key: string) =>
        ledger.POST("/groups/{groupId}/table-sessions", {
          params: { path: { groupId: group.id } },
          body: { id, title: title.trim(), currency, payerMemberId },
          headers: { "Idempotency-Key": key },
        }),
      [ledger, group.id, id, title, currency, payerMemberId],
    ),
  );

  async function onStart() {
    if (!title.trim()) return start.setError("Say where you are, so everyone finds the right bill.");
    if ((await start.run()).ok) router.replace(`/groups/${group.id}/table/${id}`);
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: "Split a bill at the table" }} />
      <Text style={styles.lead}>
        Enter what's on the bill, show everyone a QR code, and each person taps what they had. Shared plates and the tip are split fairly for you.
      </Text>
      <ErrorBanner message={start.error} />
      <Card>
        <TextField label="Where are you?" value={title} onChangeText={setTitle} maxLength={80} placeholder="Friday dinner at Mzansi" />
        <Chips label="Who's paying the bill?" options={group.members.map((m) => m.id)} value={payerMemberId} onChange={setPayer} render={(m) => (m === me.id ? "You" : nameOf(m))} />
        <Chips label="Currency" options={supportedCurrencies} value={currency} onChange={setCurrency} />
        <Button title="Start" busy={start.busy} onPress={() => void onStart()} />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({ lead: { fontSize: font.sm, color: colors.muted } });
