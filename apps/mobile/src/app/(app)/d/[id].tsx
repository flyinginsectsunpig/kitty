import { errorMessage, type PlainDraft } from "@kitty/core";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text } from "react-native";
import { useAi } from "../../../ai";
import { PlainEntry } from "../../../components/PlainEntry";
import { Card, Screen } from "../../../components/Screen";
import { colors, font, space } from "../../../theme";

/** Draft ids are random URL-safe text (see the ai service's drafts.py). */
const DRAFT_ID = /^[A-Za-z0-9_-]{16,64}$/;

type State = { status: "loading" } | { status: "ready"; draft: PlainDraft } | { status: "error"; code: string };

/**
 * The link an AI assistant (ChatGPT, Claude: MCP) gives with a draft it prepared (https://…/d/<id>), opened in the
 * app. Kitty shows its usual card, filled in; nothing is saved or sent until the person taps Save or Send here.
 */
export default function DraftLink() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const ai = useAi();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    if (!DRAFT_ID.test(id ?? "")) return setState({ status: "error", code: "not_found" });
    let live = true;
    void ai.draft(id!).then((r) => {
      if (!live) return;
      setState(r.draft ? { status: "ready", draft: r.draft } : { status: "error", code: r.error ?? "unexpected" });
    });
    return () => {
      live = false;
    };
  }, [ai, id]);

  return (
    <Screen>
      <Stack.Screen options={{ title: "Check and save" }} />
      {state.status === "loading" && <ActivityIndicator color={colors.brand600} />}
      {state.status === "error" && (
        <Card>
          <Text style={styles.body}>{errorMessage(state.code)}</Text>
        </Card>
      )}
      {state.status === "ready" && (
        <>
          <Text style={styles.note}>Your AI assistant prepared this. Nothing is saved until you tap Save.</Text>
          <PlainEntry groupId={state.draft.groupId ?? undefined} initial={{ draft: state.draft, draftId: id! }} />
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: font.base, color: colors.text },
  note: { fontSize: font.sm, color: colors.muted, marginBottom: space.sm },
});
