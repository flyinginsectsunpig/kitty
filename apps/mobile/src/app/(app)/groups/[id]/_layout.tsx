import { errorMessage, isUuid } from "@kitty/core";
import { Stack, useLocalSearchParams } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { LoadState } from "../../../../components/Screen";
import { groupContext, GroupProvider } from "../../../../group/GroupContext";
import { useLoad } from "../../../../hooks/useLoad";
import { useLedger } from "../../../../ledger";
import { colors, font, space } from "../../../../theme";

/** Every screen inside a group shares one load of the group and the signed-in user's place in it. */
export default function GroupLayout() {
  const { id } = useLocalSearchParams<{ id: string }>();
  if (!isUuid(id)) return <NotFound />;
  return <LoadedGroup id={id} />;
}

function LoadedGroup({ id }: { id: string }) {
  const ledger = useLedger();
  const state = useLoad(async () => {
    const [group, me] = await Promise.all([ledger.GET("/groups/{groupId}", { params: { path: { groupId: id } } }), ledger.GET("/me")]);
    if (group.data === undefined) return group;
    if (me.data === undefined) return { ...me, data: undefined };
    return { ...group, data: { group: group.data, userId: me.data.id } };
  }, [ledger, id]);

  return (
    <LoadState state={state}>
      {({ group, userId }) => {
        const value = groupContext(group, userId, state.reload);
        if (!value) return <NotFound />;
        return (
          <GroupProvider value={value}>
            <Stack screenOptions={{ title: group.name }} />
          </GroupProvider>
        );
      }}
    </LoadState>
  );
}

function NotFound() {
  return (
    <View style={styles.center}>
      <Text style={styles.muted}>{errorMessage("not_found")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, padding: space.xl, justifyContent: "center", backgroundColor: colors.bg },
  muted: { color: colors.muted, fontSize: font.base, textAlign: "center" },
});
