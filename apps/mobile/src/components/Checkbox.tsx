import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, font, space } from "../theme";

export function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} accessibilityLabel={label} onPress={() => onChange(!checked)} style={styles.row} hitSlop={6}>
      <View style={[styles.box, checked && styles.on]}>{checked && <Text style={styles.tick}>✓</Text>}</View>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44, flex: 1 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: colors.fieldBorder, alignItems: "center", justifyContent: "center", backgroundColor: colors.card },
  on: { backgroundColor: colors.brand600, borderColor: colors.brand600 },
  tick: { color: "#fff", fontSize: 14, fontWeight: "700" },
  label: { fontSize: font.base, color: colors.text },
});
