import type { TableSession } from "@kitty/core";
import { formatMoney } from "@kitty/money";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, font, radius, space } from "../../theme";
import { Card } from "../Screen";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** The bill's lines with who claimed each. With `onToggle`, each row is a big tap target that claims or un-claims. */
export function ItemList({ session, meId, onToggle, busyItemId }: {
  session: TableSession;
  meId: string | null;
  onToggle?: (itemId: string, claim: boolean) => void;
  busyItemId?: string | null;
}) {
  if (session.items.length === 0)
    return (
      <Card>
        <Text style={styles.muted}>No items yet. The host is adding them.</Text>
      </Card>
    );

  return (
    <View style={styles.list}>
      {session.items.map((item) => {
        const mine = item.claimants.some((c) => c.id === meId);
        const who = item.claimants.length === 0 ? "nobody yet" : item.claimants.map((c) => (c.id === meId ? "you" : c.displayName)).join(", ");
        const content = (
          <View style={styles.row}>
            <View style={styles.grow}>
              <Text style={styles.name} numberOfLines={1}>
                {item.quantity > 1 && <Text style={styles.muted}>{item.quantity}× </Text>}
                {item.description}
              </Text>
              <View style={styles.claimants}>
                {item.claimants.length === 0 ? (
                  <Text style={styles.small}>Nobody yet: shared by everyone</Text>
                ) : (
                  item.claimants.map((c) => (
                    <View key={c.id} style={[styles.dot, c.id === meId && styles.dotMine]}>
                      <Text style={[styles.dotText, c.id === meId && styles.dotTextMine]}>{initials(c.displayName)}</Text>
                    </View>
                  ))
                )}
              </View>
            </View>
            <Text style={styles.amount}>{formatMoney(item.lineTotalMinor, session.currency)}</Text>
          </View>
        );
        return onToggle ? (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityLabel={`${item.description}, ${formatMoney(item.lineTotalMinor, session.currency)}, ${who}`}
            accessibilityState={{ selected: mine, disabled: busyItemId === item.id }}
            disabled={busyItemId === item.id}
            onPress={() => onToggle(item.id, !mine)}
            style={({ pressed }) => [styles.item, mine && styles.itemMine, (pressed || busyItemId === item.id) && styles.pressed]}
          >
            {content}
          </Pressable>
        ) : (
          <View key={item.id} style={styles.item}>
            {content}
          </View>
        );
      })}
    </View>
  );
}

/** Per-person totals from the server's preview (the same rule the confirmed expense uses). */
export function PreviewTotals({ session, meId }: { session: TableSession; meId: string | null }) {
  if (session.preview.length === 0) return null;
  return (
    <Card>
      {session.preview.map((p) => (
        <View key={p.id} style={styles.row}>
          <Text style={styles.body}>
            {p.id === meId ? "You" : p.displayName}
            {p.kind === "guest" && <Text style={styles.small}> (guest)</Text>}
          </Text>
          <Text style={styles.body}>{formatMoney(p.amountMinor, session.currency)}</Text>
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.sm },
  item: { backgroundColor: colors.card, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, padding: space.md, minHeight: 56 },
  itemMine: { borderColor: colors.brand500, backgroundColor: colors.brand50 },
  pressed: { opacity: 0.7 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
  grow: { flex: 1, gap: space.xs },
  claimants: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  dot: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: colors.border },
  dotMine: { backgroundColor: colors.brand600 },
  dotText: { fontSize: 10, fontWeight: "700", color: colors.muted },
  dotTextMine: { color: "#fff" },
  name: { fontSize: font.base, fontWeight: "500", color: colors.text },
  amount: { fontSize: font.base, color: colors.text, fontVariant: ["tabular-nums"] },
  body: { fontSize: font.sm, color: colors.text },
  small: { fontSize: 12, color: colors.muted },
  muted: { fontSize: font.sm, color: colors.muted },
});
