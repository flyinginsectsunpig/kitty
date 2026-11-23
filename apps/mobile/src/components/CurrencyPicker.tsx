import { supportedCurrencies } from "@kitty/money";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, font, space } from "../theme";
import { Button } from "./Button";
import { Chips } from "./Chips";

/** The chosen currency, with the full list only when asked for (30 chips would swamp a phone form). */
export function CurrencyPicker({ label, value, onChange }: { label: string; value: string; onChange: (currency: string) => void }) {
  const [open, setOpen] = useState(false);
  if (open)
    return (
      <Chips
        label={label}
        options={supportedCurrencies}
        value={value}
        onChange={(c) => {
          onChange(c);
          setOpen(false);
        }}
      />
    );
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        <Text style={styles.value}>{value}</Text>
        <View style={styles.change}>
          <Button title="Change currency" variant="secondary" onPress={() => setOpen(true)} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs },
  label: { fontSize: font.sm, fontWeight: "500", color: colors.muted },
  row: { flexDirection: "row", alignItems: "center", gap: space.md },
  value: { fontSize: font.lg, fontWeight: "600", color: colors.text, minWidth: 48 },
  change: { flex: 1 },
});
