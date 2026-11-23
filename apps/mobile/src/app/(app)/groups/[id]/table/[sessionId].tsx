import { errorMessage, isUuid } from "@kitty/core";
import { Stack, useLocalSearchParams } from "expo-router";
import { StyleSheet, Text } from "react-native";
import { LoadState, Screen } from "../../../../../components/Screen";
import { ClaimTable } from "../../../../../components/table/ClaimTable";
import { useGroup } from "../../../../../group/GroupContext";
import { useLoad } from "../../../../../hooks/useLoad";
import { useLedger } from "../../../../../ledger";
import { colors, font } from "../../../../../theme";

/** One bill at the table. The host runs it; everyone else in the group claims what they had. */
export default function TableScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  if (!isUuid(sessionId))
    return (
      <Screen>
        <Text style={styles.muted}>{errorMessage("not_found")}</Text>
      </Screen>
    );
  return <Loaded sessionId={sessionId} />;
}

function Loaded({ sessionId }: { sessionId: string }) {
  const ledger = useLedger();
  const { group } = useGroup();
  const state = useLoad(async () => {
    // The bill itself, and the group's open bills, which say whether this viewer is hosting it.
    const [bill, active] = await Promise.all([
      ledger.GET("/groups/{groupId}/table-sessions/{sessionId}", { params: { path: { groupId: group.id, sessionId } } }),
      ledger.GET("/groups/{groupId}/table-sessions", { params: { path: { groupId: group.id } } }),
    ]);
    if (bill.data === undefined) return bill;
    if (active.data === undefined) return { ...active, data: undefined };
    return { ...bill, data: { bill: bill.data, hosting: active.data.some((t) => t.id === sessionId && t.hostedByMe) } };
  }, [ledger, group.id, sessionId]);

  return (
    <>
      <Stack.Screen options={{ title: "Split the bill" }} />
      <LoadState state={state}>{({ bill }) => <ClaimTable initial={bill} groupId={group.id} />}</LoadState>
    </>
  );
}

const styles = StyleSheet.create({ muted: { fontSize: font.base, color: colors.muted, textAlign: "center" } });
