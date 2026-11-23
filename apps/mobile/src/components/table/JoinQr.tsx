import { Share, StyleSheet, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { config } from "../../config";
import { colors, font, radius, space } from "../../theme";
import { Button } from "../Button";
import { CopyButton } from "../CopyButton";
import { Card } from "../Screen";

/** The same link web's QR code holds: a browser opens the web page (guests welcome), the app opens the bill. */
export const tableLink = (sessionId: string, groupId: string) => `${config.webUrl}/t/${sessionId}?g=${groupId}`;

export function JoinQr({ sessionId, groupId }: { sessionId: string; groupId: string }) {
  const link = tableLink(sessionId, groupId);
  return (
    <Card>
      <Text style={styles.h2}>2. Everyone scans and taps what they had</Text>
      <View style={styles.qr} accessible accessibilityLabel="QR code to join this table">
        <QRCode value={link} size={200} />
      </View>
      <Text style={styles.muted}>No account needed. Friends in the group are recognised when signed in.</Text>
      <View style={styles.row}>
        <Text style={styles.code} numberOfLines={1} selectable>
          {link}
        </Text>
        <CopyButton text={link} />
      </View>
      <Button title="Share link" variant="secondary" onPress={() => void Share.share({ message: link }).catch(() => {})} />
    </Card>
  );
}

const styles = StyleSheet.create({
  h2: { fontSize: font.base, fontWeight: "600", color: colors.text },
  qr: { alignSelf: "center", padding: space.md, backgroundColor: "#fff", borderRadius: radius.field },
  muted: { fontSize: font.sm, color: colors.muted },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm },
  code: { flex: 1, fontSize: 12, color: colors.text, backgroundColor: "#f5f5f4", borderRadius: radius.field, padding: space.sm },
});
