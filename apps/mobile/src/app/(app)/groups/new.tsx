import { supportedCurrencies } from "@kitty/money";
import { randomUUID } from "expo-crypto";
import { Stack, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Button } from "../../../components/Button";
import { Chips } from "../../../components/Chips";
import { ErrorBanner } from "../../../components/ErrorBanner";
import { Card, Screen } from "../../../components/Screen";
import { TextField } from "../../../components/TextField";
import { useAction } from "../../../hooks/useAction";
import { useLedger } from "../../../ledger";

export default function NewGroupScreen() {
  const ledger = useLedger();
  const router = useRouter();
  const id = useRef(randomUUID()).current; // the group's id, fixed for this form so a retry can't make two
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("ZAR");
  const create = useAction(
    useCallback(
      (key: string) => ledger.POST("/groups", { body: { id, name: name.trim(), baseCurrency: currency }, headers: { "Idempotency-Key": key } }),
      [ledger, id, name, currency],
    ),
  );

  async function onCreate() {
    if (!name.trim()) return create.setError("Give the group a name.");
    if ((await create.run()).ok) router.replace({ pathname: "/groups/[id]", params: { id } });
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: "New group" }} />
      <ErrorBanner message={create.error} />
      <Card>
        <TextField label="Name" value={name} onChangeText={setName} maxLength={60} placeholder="Flat 4B, Cape Town trip…" autoFocus />
        <Chips label="Main currency" options={supportedCurrencies} value={currency} onChange={setCurrency} />
        <Button title="Create group" busy={create.busy} onPress={() => void onCreate()} />
      </Card>
    </Screen>
  );
}
