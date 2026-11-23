import { StyleSheet, Text, View } from "react-native";
import { colors, font, radius, space } from "../theme";

/** One line saying what went wrong. Renders nothing without a message. */
export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <View accessible accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.box}>
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: colors.errorBg, borderRadius: radius.field, padding: space.md, borderWidth: 1, borderColor: "#fecaca" },
  text: { color: colors.owes, fontSize: font.sm },
});
