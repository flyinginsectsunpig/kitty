import { describeActivity, type ActivitySnapshot } from "@kitty/core";
import { StyleSheet, Text, View } from "react-native";
import { GroupNav } from "../../../../components/GroupNav";
import { Card, LoadState, Screen } from "../../../../components/Screen";
import { useGroup } from "../../../../group/GroupContext";
import { useLoad } from "../../../../hooks/useLoad";
import { useLedger } from "../../../../ledger";
import { colors, font, space } from "../../../../theme";

const when = (iso: string) => new Date(iso).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" });

export default function ActivityScreen() {
  const ledger = useLedger();
  const { group } = useGroup();
  const feed = useLoad(() => ledger.GET("/groups/{groupId}/activity", { params: { path: { groupId: group.id }, query: { limit: 100 } } }), [ledger, group.id]);

  return (
    <Screen onRefresh={() => void feed.reload()} refreshing={feed.loading && feed.data !== null}>
      <GroupNav groupId={group.id} active="/activity" />
      <LoadState state={feed}>
        {(entries) => (
          <Card>
            {entries.length === 0 && <Text style={styles.muted}>Nothing has happened in this group yet.</Text>}
            {entries.map((a) => (
              <View key={a.id} style={styles.entry}>
                <Text testID="activity-line" style={styles.body}>
                  {`${a.actorDisplayName} ${a.action} ${describeActivity(a.entityType, (a.after ?? a.before) as ActivitySnapshot)}`}
                </Text>
                <Text style={styles.small}>{when(a.at)}</Text>
              </View>
            ))}
          </Card>
        )}
      </LoadState>
    </Screen>
  );
}

const styles = StyleSheet.create({
  entry: { paddingVertical: space.sm, gap: 2, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  body: { fontSize: font.sm, color: colors.text },
  small: { fontSize: 12, color: colors.muted },
  muted: { fontSize: font.sm, color: colors.muted },
});
