import type { NotificationSettingsDto, NotificationSettingsWriteDto } from "@kitty/api-client";
import { NOTIFICATION_ROWS, type NotificationField } from "@kitty/core";
import { Stack } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Checkbox } from "../../components/Checkbox";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Card, LoadState, Screen } from "../../components/Screen";
import { useAction } from "../../hooks/useAction";
import { useLoad } from "../../hooks/useLoad";
import { useLedger } from "../../ledger";
import { colors, font, space } from "../../theme";

/** Which news reaches this person, by push and by email. Each switch saves as it's flipped; the others wait meanwhile. */
export default function NotificationsScreen() {
  const ledger = useLedger();
  const loaded = useLoad(() => ledger.GET("/me/notifications"), [ledger]);
  const [settings, setSettings] = useState<NotificationSettingsDto | null>(null);
  useEffect(() => setSettings(loaded.data), [loaded.data]);

  const next = useRef<NotificationSettingsWriteDto | null>(null);
  const save = useAction(
    useCallback((key: string) => ledger.PUT("/me/notifications", { body: next.current!, headers: { "Idempotency-Key": key } }), [ledger]),
  );

  const flip = async (field: NotificationField, on: boolean) => {
    if (!settings) return;
    const before = settings;
    const updated = { ...settings, [field]: on };
    setSettings(updated);
    const { emailAvailable: _, ...body } = updated;
    next.current = body;
    if (!(await save.run()).ok) setSettings(before); // put the switch back: it didn't save
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: "Notifications" }} />
      <ErrorBanner message={save.error} />
      <LoadState state={loaded}>
        {() =>
          settings && (
            <>
              {NOTIFICATION_ROWS.map((row) => (
                <Card key={row.kind}>
                  <Text style={styles.label}>{row.label}</Text>
                  <View style={styles.switches}>
                    <Checkbox
                      label="Push"
                      accessibilityLabel={`${row.label}: push`}
                      checked={settings[row.push]}
                      disabled={save.busy}
                      onChange={(on) => flip(row.push, on)}
                    />
                    <Checkbox
                      label="Email"
                      accessibilityLabel={`${row.label}: email`}
                      checked={settings[row.email]}
                      disabled={save.busy || !settings.emailAvailable}
                      onChange={(on) => flip(row.email, on)}
                    />
                  </View>
                </Card>
              ))}
              {!settings.emailAvailable && <Text style={styles.muted}>Verify your email address to get email.</Text>}
            </>
          )
        }
      </LoadState>
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: font.base, fontWeight: "600", color: colors.text },
  switches: { flexDirection: "row", gap: space.md },
  muted: { fontSize: font.sm, color: colors.muted },
});
