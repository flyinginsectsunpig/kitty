import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { colors, font, radius, space } from "../theme";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() =>
        void Clipboard.setStringAsync(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
      }
      style={styles.button}
    >
      <Text style={styles.text}>{copied ? "Copied" : label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { minHeight: 40, paddingHorizontal: space.md, justifyContent: "center", borderRadius: radius.field, borderWidth: 1, borderColor: colors.fieldBorder, backgroundColor: colors.card },
  text: { fontSize: font.sm, fontWeight: "600", color: colors.text },
});
