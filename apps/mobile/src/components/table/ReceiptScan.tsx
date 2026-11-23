import type { LedgerProblem } from "@kitty/api-client";
import { errorMessage, SCAN_PRIVACY_NOTE, scanStatusMessage, settle, SLOW_SCAN_MS, uploadReceipt, type TableSession } from "@kitty/core";
import { randomUUID } from "expo-crypto";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useLedger } from "../../ledger";
import { preparePhoto } from "../../lib/photo";
import { colors, font, space } from "../../theme";
import { Button } from "../Button";
import { ErrorBanner } from "../ErrorBanner";
import { Card } from "../Screen";

export const CAMERA_DENIED = "Allow camera access in Settings, or choose a photo instead.";

type Result = { session: TableSession | null; error: string | null };
const code = (error: unknown) => (error as LedgerProblem | undefined)?.code ?? "unexpected";
/** The bill from a scan call, or its problem code. (These routes declare no error body, so `error` is untyped.) */
const outcome = (r: { data?: TableSession; response: Response }): Result =>
  r.data ? { session: r.data, error: null } : { session: null, error: code((r as { error?: unknown }).error) };

/** The host photographs the receipt (or picks a photo); the items fill in on every screen once it's read. */
export function ReceiptScan({ session, groupId, onSession }: { session: TableSession; groupId: string; onSession: (s: TableSession) => void }) {
  const ledger = useLedger();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scan = session.scan;
  const reading = scan?.status === "parsing";
  const path = { params: { path: { groupId, sessionId: session.id } } };

  // Note when this scan started reading (as seen here), and tick until the "still reading" nudge is due.
  const [readingSince, setReadingSince] = useState<{ id: string; at: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  if (reading && readingSince?.id !== scan.id) setReadingSince({ id: scan.id, at: Date.now() });
  const waited = reading && readingSince ? now - readingSince.at : 0;
  useEffect(() => {
    if (!reading || waited >= SLOW_SCAN_MS) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [reading, waited]);

  async function run(action: () => Promise<Result>) {
    setBusy(true);
    setError(null);
    const result = await settle(action); // never throws, so busy always clears
    if (result.session) onSession(result.session);
    setError(errorMessage(result.error ?? undefined));
    setBusy(false);
  }

  async function pick(from: "camera" | "library") {
    setError(null);
    if (from === "camera" && !(await ImagePicker.requestCameraPermissionsAsync()).granted) return setError(CAMERA_DENIED);
    const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 1, exif: false };
    const picked = from === "camera" ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
    const asset = picked.canceled ? null : picked.assets?.[0];
    if (!asset) return;
    await run(async () => {
      const photo = await preparePhoto(asset).catch(() => null);
      if (!photo) return { session: null, error: "upload_not_image" };
      return uploadReceipt(
        photo,
        async (contentType) => {
          const r = await ledger.POST("/groups/{groupId}/table-sessions/{sessionId}/scans", { ...path, body: { id: randomUUID(), contentType } });
          return r.data ? { scanId: r.data.scanId, uploadUrl: r.data.uploadUrl } : { error: code(r.error) };
        },
        async (scanId) => {
          return outcome(await ledger.POST("/groups/{groupId}/table-sessions/{sessionId}/scans/{scanId}/uploaded", { params: { path: { ...path.params.path, scanId } } }));
        },
      );
    });
  }

  function apply(scanId: string) {
    void run(async () => {
      return outcome(await ledger.POST("/groups/{groupId}/table-sessions/{sessionId}/scans/{scanId}/apply", { params: { path: { ...path.params.path, scanId } } }));
    });
  }

  const off = busy || reading;
  return (
    <Card>
      <Text style={styles.h2}>Scan the receipt</Text>
      <Text style={styles.small}>Or type the items below.</Text>
      <View style={styles.pair}>
        <View style={styles.grow}>
          <Button title={scan ? "Scan again" : "Take photo"} variant="secondary" busy={busy} disabled={off} onPress={() => void pick("camera")} />
        </View>
        <View style={styles.grow}>
          <Button title="Choose photo" variant="secondary" disabled={off} onPress={() => void pick("library")} />
        </View>
      </View>
      <ErrorBanner message={error} />
      {scan && (
        <Text accessibilityLiveRegion="polite" style={styles.status}>
          {scanStatusMessage(scan, waited, session.items.length, session.currency)}
        </Text>
      )}
      {scan?.status === "parsed" && scan.suggestedItems && <Button title="Use the scanned items" disabled={busy} onPress={() => apply(scan.id)} />}
      <Text style={styles.small}>{SCAN_PRIVACY_NOTE}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  h2: { fontSize: font.base, fontWeight: "600", color: colors.text },
  small: { fontSize: 12, color: colors.muted },
  status: { fontSize: font.sm, color: colors.text },
  pair: { flexDirection: "row", gap: space.sm },
  grow: { flex: 1 },
});
