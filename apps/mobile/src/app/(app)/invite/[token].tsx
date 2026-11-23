import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback } from "react";
import { StyleSheet, Text } from "react-native";
import { Button } from "../../../components/Button";
import { ErrorBanner } from "../../../components/ErrorBanner";
import { Card, LoadState, Screen } from "../../../components/Screen";
import { useAction } from "../../../hooks/useAction";
import { useLoad } from "../../../hooks/useLoad";
import { useLedger } from "../../../ledger";
import { colors, font, space } from "../../../theme";

/** Opened from an invite link (kitty://invite/<token> or the https link). Signed-out visitors sign in first. */
export default function InviteScreen() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const ledger = useLedger();
  const router = useRouter();
  const path = { params: { path: { token } } };
  const invite = useLoad(() => ledger.GET("/invites/{token}", path), [ledger, token]);
  const accept = useAction(useCallback((key: string) => ledger.POST("/invites/{token}/accept", { ...path, headers: { "Idempotency-Key": key } }), [ledger, token]));

  async function onJoin() {
    const r = await accept.run();
    if (r.ok && r.data) router.replace(`/groups/${r.data.id}`);
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: "Invite" }} />
      <LoadState state={invite}>
        {(i) => (
          <Card>
            <Text style={styles.kicker}>You're invited to</Text>
            <Text style={styles.title}>{i.groupName}</Text>
            {i.placeholderName && (
              <Text style={styles.body}>
                You'll take over the spot named <Text style={styles.strong}>{i.placeholderName}</Text>, with everything already recorded for them.
              </Text>
            )}
            <ErrorBanner message={accept.error} />
            <Button title="Join group" busy={accept.busy} onPress={() => void onJoin()} />
          </Card>
        )}
      </LoadState>
    </Screen>
  );
}

const styles = StyleSheet.create({
  kicker: { fontSize: font.sm, color: colors.muted, textTransform: "uppercase", letterSpacing: 1, textAlign: "center" },
  title: { fontSize: font.xl, fontWeight: "700", color: colors.text, textAlign: "center", marginBottom: space.sm },
  body: { fontSize: font.base, color: colors.muted, textAlign: "center" },
  strong: { fontWeight: "600", color: colors.text },
});
