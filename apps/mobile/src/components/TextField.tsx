import { StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { colors, font, radius, space } from "../theme";

/** A labelled text input; the label is also its accessibility label. */
export function TextField({ label, ...input }: { label: string } & TextInputProps) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor={colors.faint} style={styles.field} {...input} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs },
  label: { fontSize: font.sm, fontWeight: "500", color: colors.muted },
  field: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.fieldBorder,
    borderRadius: radius.field,
    paddingHorizontal: space.md,
    fontSize: font.base,
    color: colors.text,
    backgroundColor: colors.card,
  },
});
