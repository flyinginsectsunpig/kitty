import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, font, space } from "../theme";

/** Pick one of a few options (a native stand-in for a select). */
export function Chips<T extends string>({ label, options, value, onChange, render = (o) => o }: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  render?: (option: T) => string;
}) {
  return (
    <View style={styles.wrap} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        {options.map((o) => {
          const selected = o === value;
          return (
            <Pressable
              key={o}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => onChange(o)}
              style={[styles.chip, selected && styles.selected]}
            >
              <Text style={[styles.text, selected && styles.selectedText]}>{render(o)}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs },
  label: { fontSize: font.sm, fontWeight: "500", color: colors.muted },
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: { minHeight: 40, paddingHorizontal: space.md, justifyContent: "center", borderRadius: 999, borderWidth: 1, borderColor: colors.fieldBorder, backgroundColor: colors.card },
  selected: { backgroundColor: colors.brand600, borderColor: colors.brand600 },
  text: { fontSize: font.sm, color: colors.text },
  selectedText: { color: "#fff", fontWeight: "600" },
});
