import { errorMessage } from "@kitty/core";
import type { ReactNode } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Loaded } from "../hooks/useLoad";
import { colors, font, radius, space } from "../theme";
import { Button } from "./Button";
import { ErrorBanner } from "./ErrorBanner";

/** A scrolling page in the app's colours. Pull to refresh when `onRefresh` is given. */
export function Screen({ children, onRefresh, refreshing = false }: { children: ReactNode; onRefresh?: () => void; refreshing?: boolean }) {
  return (
    <ScrollView
      testID="screen"
      style={styles.page}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined}
    >
      {children}
    </ScrollView>
  );
}

/**
 * The first load of a screen: a spinner, "not found", or the error with a way to try again. Renders `children` with the
 * data once it has some (later reload failures show above it, keeping what was already on screen).
 */
export function LoadState<T>({ state, children }: { state: Loaded<T>; children: (data: T) => ReactNode }) {
  if (state.notFound)
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>{errorMessage("not_found")}</Text>
      </View>
    );
  if (state.data === null) {
    if (state.error)
      return (
        <View style={styles.center}>
          <ErrorBanner message={state.error} />
          <Button title="Try again" variant="secondary" onPress={() => void state.reload()} />
        </View>
      );
    return (
      <View style={styles.center}>
        <ActivityIndicator accessibilityLabel="Loading" />
      </View>
    );
  }
  return (
    <>
      <ErrorBanner message={state.error} />
      {children(state.data)}
    </>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, gap: space.md },
  center: { flex: 1, gap: space.md, paddingVertical: space.xxl, alignItems: "stretch", justifyContent: "center" },
  muted: { color: colors.muted, fontSize: font.base, textAlign: "center" },
  card: { backgroundColor: colors.card, borderRadius: radius.card, borderWidth: 1, borderColor: colors.border, padding: space.lg, gap: space.sm },
});
