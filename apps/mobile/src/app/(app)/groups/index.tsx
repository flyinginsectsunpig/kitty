import type { GroupSummaryDto } from "@kitty/api-client";
import { formatMoney } from "@kitty/money";
import { Link, Stack } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../../auth/AuthProvider";
import { Button } from "../../../components/Button";
import { Card, LoadState, Screen } from "../../../components/Screen";
import { useLoad } from "../../../hooks/useLoad";
import { useReloadOnReturn } from "../../../hooks/useReloadOnReturn";
import { useLedger } from "../../../ledger";
import { colors, font, space } from "../../../theme";

export default function GroupsScreen() {
  const ledger = useLedger();
  const { signOut } = useAuth();
  const groups = useLoad(() => ledger.GET("/groups"), [ledger]);
  useReloadOnReturn(groups.reload); // back from creating or joining a group

  return (
    <Screen onRefresh={() => void groups.reload()} refreshing={groups.loading && groups.data !== null}>
      <Stack.Screen
        options={{
          title: "Your groups",
          headerRight: () => (
            <Pressable accessibilityRole="button" onPress={() => void signOut()} hitSlop={12}>
              <Text style={styles.headerLink}>Sign out</Text>
            </Pressable>
          ),
        }}
      />
      <Link href="/groups/new" asChild>
        <Button title="New group" onPress={() => {}} />
      </Link>
      <LoadState state={groups}>
        {(list) =>
          list.length === 0 ? (
            <Card>
              <Text style={styles.muted}>No groups yet. Start one for your flat, a trip or a dinner.</Text>
            </Card>
          ) : (
            list.map((g) => <GroupRow key={g.id} group={g} />)
          )
        }
      </LoadState>
    </Screen>
  );
}

function GroupRow({ group: g }: { group: GroupSummaryDto }) {
  return (
    <Link href={{ pathname: "/groups/[id]", params: { id: g.id } }} asChild>
      <Pressable accessibilityRole="link">
        <Card>
          <View style={styles.row}>
            <View style={styles.grow}>
              <Text style={styles.name}>{g.name}</Text>
              <Text style={styles.muted}>
                {g.memberCount} {g.memberCount === 1 ? "person" : "people"}
              </Text>
            </View>
            <View style={styles.right}>
              {g.myNet.length === 0 ? (
                <Text style={styles.muted}>Settled up</Text>
              ) : (
                g.myNet.map((n) => (
                  <Text key={n.currency} style={n.netMinor > 0 ? styles.owed : styles.owes}>
                    {n.netMinor > 0 ? "You're owed " : "You owe "}
                    {formatMoney(Math.abs(n.netMinor), n.currency)}
                  </Text>
                ))
              )}
            </View>
          </View>
        </Card>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.md },
  grow: { flex: 1, gap: space.xs },
  right: { alignItems: "flex-end", gap: space.xs },
  name: { fontSize: font.base, fontWeight: "600", color: colors.text },
  muted: { fontSize: font.sm, color: colors.muted },
  owed: { fontSize: font.sm, color: colors.owed },
  owes: { fontSize: font.sm, color: colors.owes },
  headerLink: { color: colors.brand600, fontSize: font.base, fontWeight: "600" },
});
