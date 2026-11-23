import { safeNext } from "@kitty/core";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useAuth } from "../auth/AuthProvider";
import { Button } from "../components/Button";
import { ErrorBanner } from "../components/ErrorBanner";
import { colors, font, space } from "../theme";

export default function SignIn() {
  const { signIn, notice } = useAuth();
  const router = useRouter();
  const { next } = useLocalSearchParams<{ next?: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSignIn() {
    setBusy(true);
    setError(null);
    try {
      if (await signIn()) router.replace(safeNext(next));
    } catch {
      setError("Couldn't reach Kitty to sign in. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.page}>
      <Text style={styles.title}>Split costs, not friendships.</Text>
      <Text style={styles.lead}>Unlimited expenses, no ads, free forever. Track who owes what in your flat, your friend group or your next trip.</Text>
      {notice && <Text style={styles.notice}>{notice}</Text>}
      <ErrorBanner message={error} />
      <Button title="Sign in" onPress={() => void onSignIn()} busy={busy} />
      <Text style={styles.hint}>New here? You can create an account on the next screen.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, justifyContent: "center", padding: space.xl, gap: space.lg, backgroundColor: colors.bg },
  title: { fontSize: font.title, fontWeight: "700", color: colors.text, textAlign: "center" },
  lead: { fontSize: font.base, color: colors.muted, textAlign: "center" },
  notice: { fontSize: font.sm, color: colors.text, textAlign: "center" },
  hint: { fontSize: font.sm, color: colors.muted, textAlign: "center" },
});
