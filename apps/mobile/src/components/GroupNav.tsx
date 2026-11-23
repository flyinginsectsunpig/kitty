import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, font, radius, space } from "../theme";

const TABS = [
  { path: "", label: "Overview" },
  { path: "/settle", label: "Settle up" },
  { path: "/members", label: "People" },
  { path: "/activity", label: "Activity" },
] as const;

export type GroupTab = (typeof TABS)[number]["path"];

/** The group's sections, as on web: switching replaces the screen rather than stacking it. */
export function GroupNav({ groupId, active }: { groupId: string; active: GroupTab }) {
  const router = useRouter();
  return (
    <View style={styles.bar} accessibilityRole="tablist">
      {TABS.map((t) => {
        const selected = t.path === active;
        return (
          <Pressable
            key={t.path}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => !selected && router.replace(`/groups/${groupId}${t.path}`)}
            style={[styles.tab, selected && styles.selected]}
          >
            <Text style={[styles.text, selected && styles.selectedText]} numberOfLines={1}>
              {t.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", gap: space.xs, padding: space.xs, borderRadius: radius.field, backgroundColor: "#e7e5e499" },
  tab: { flex: 1, minHeight: 40, borderRadius: 8, alignItems: "center", justifyContent: "center", paddingHorizontal: space.xs },
  selected: { backgroundColor: colors.card },
  text: { fontSize: font.sm, fontWeight: "500", color: colors.muted },
  selectedText: { color: colors.text },
});
