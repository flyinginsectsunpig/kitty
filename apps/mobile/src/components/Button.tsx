import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";
import { colors, font, radius, space } from "../theme";

type Props = {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  busy?: boolean;
  /** When the visible title alone is ambiguous ("Invite" on every row). */
  accessibilityLabel?: string;
};

export function Button({ title, onPress, variant = "primary", disabled = false, busy = false, accessibilityLabel }: Props) {
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: off, busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [styles.base, styles[variant], pressed && !off && styles.pressed, off && styles.off]}
    >
      {busy ? <ActivityIndicator color={variant === "primary" ? "#fff" : colors.text} /> : <Text style={[styles.text, variant === "primary" ? styles.onPrimary : variant === "danger" ? styles.onDanger : null]}>{title}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: 48, borderRadius: radius.field, paddingHorizontal: space.lg, alignItems: "center", justifyContent: "center" },
  primary: { backgroundColor: colors.brand600 },
  secondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.fieldBorder },
  danger: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.owes },
  pressed: { opacity: 0.85 },
  off: { opacity: 0.5 },
  text: { fontSize: font.base, fontWeight: "600", color: colors.text },
  onPrimary: { color: "#fff" },
  onDanger: { color: colors.owes },
});
