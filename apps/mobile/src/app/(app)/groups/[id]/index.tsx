import type { BalancesDto, ExpenseDto } from "@kitty/api-client";
import { errorMessage } from "@kitty/core";
import { formatMoney } from "@kitty/money";
import { Link, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Button } from "../../../../components/Button";
import { ErrorBanner } from "../../../../components/ErrorBanner";
import { GroupNav } from "../../../../components/GroupNav";
import { Card, LoadState, Screen } from "../../../../components/Screen";
import { useGroup } from "../../../../group/GroupContext";
import { problemMessage } from "../../../../hooks/useAction";
import { useLoad } from "../../../../hooks/useLoad";
import { useLedger } from "../../../../ledger";
import { colors, font, space } from "../../../../theme";

const PAGE = 30;

const pageKey = (items: ExpenseDto[]) => items.map((e) => `${e.id}:${e.version}`).join(",");

export default function GroupOverview() {
  const ledger = useLedger();
  const { group } = useGroup();
  const groupId = group.id;
  const path = { params: { path: { groupId } } };
  const state = useLoad(async () => {
    const [balances, tables, first] = await Promise.all([
      ledger.GET("/groups/{groupId}/balances", path),
      ledger.GET("/groups/{groupId}/table-sessions", path),
      ledger.GET("/groups/{groupId}/expenses", { params: { path: { groupId }, query: { limit: PAGE } } }),
    ]);
    for (const r of [balances, tables, first]) if (r.data === undefined) return { ...r, data: undefined };
    return { ...balances, data: { balances: balances.data!, tables: tables.data!, first: first.data! } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledger, groupId]);

  // Coming back from adding or editing an expense: show the change. The first focus is the load above.
  const focusedBefore = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focusedBefore.current) void state.reload();
      focusedBefore.current = true;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  return (
    <Screen onRefresh={() => void state.reload()} refreshing={state.loading && state.data !== null}>
      <GroupNav groupId={groupId} active="" />
      <View style={styles.actions}>
        <Link href={`/groups/${groupId}/expenses/new`} asChild>
          <Button title="Add an expense" onPress={() => {}} />
        </Link>
        <Link href={`/groups/${groupId}/table/new`} asChild>
          <Button title="Split a bill at the table" variant="secondary" onPress={() => {}} />
        </Link>
      </View>
      <LoadState state={state}>
        {({ balances, tables, first }) => (
          <>
            {tables.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.h2}>Bills being split</Text>
                {tables.map((t) => (
                  <Link key={t.id} href={`/groups/${groupId}/table/${t.id}`} asChild>
                    <Pressable accessibilityRole="link">
                      <Card>
                        <Text style={styles.name}>{t.title}</Text>
                        <Text style={styles.muted}>
                          {t.status === "locked" ? "locked" : "open"} · {t.hostedByMe ? "you're hosting" : "tap what you had"}
                        </Text>
                      </Card>
                    </Pressable>
                  </Link>
                ))}
              </View>
            )}
            <Balances balances={balances} groupId={groupId} />
            {/* A reload that changed the first page (an edit, a new expense) starts the list over from it. */}
            <Expenses key={pageKey(first.items)} groupId={groupId} first={first} />
          </>
        )}
      </LoadState>
    </Screen>
  );
}

function Balances({ balances, groupId }: { balances: BalancesDto; groupId: string }) {
  const { me, nameOf } = useGroup();
  return (
    <Card>
      <Text style={styles.h2}>Balances</Text>
      {balances.currencies.length === 0 ? (
        <Text style={styles.muted}>Nothing to settle yet.</Text>
      ) : (
        balances.currencies.map((c) => (
          <View key={c.currency} style={styles.section}>
            {balances.currencies.length > 1 && <Text style={styles.caps}>{c.currency}</Text>}
            {c.members.map((m) => (
              <View key={m.memberId} style={styles.line}>
                <Text style={styles.body}>{m.memberId === me.id ? "You" : nameOf(m.memberId)}</Text>
                <Text style={m.netMinor > 0 ? styles.owed : m.netMinor < 0 ? styles.owes : styles.muted}>
                  {m.netMinor === 0 ? "settled" : `${m.netMinor > 0 ? "gets back" : "owes"} ${formatMoney(Math.abs(m.netMinor), c.currency)}`}
                </Text>
              </View>
            ))}
          </View>
        ))
      )}
      {balances.currencies.some((c) => c.transfers.length > 0) && (
        <Link href={`/groups/${groupId}/settle`} asChild>
          <Button title="See the simplest way to settle up" variant="secondary" onPress={() => {}} />
        </Link>
      )}
    </Card>
  );
}

/** The first page comes with the screen; "Older expenses" appends the next. */
function Expenses({ groupId, first }: { groupId: string; first: { items: ExpenseDto[]; nextCursor: string | null } }) {
  const ledger = useLedger();
  const { me, nameOf } = useGroup();
  const [items, setItems] = useState(first.items);
  const [cursor, setCursor] = useState(first.nextCursor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function more() {
    if (!cursor) return;
    setBusy(true);
    setError(null);
    try {
      const { data, error: problem } = await ledger.GET("/groups/{groupId}/expenses", { params: { path: { groupId }, query: { cursor, limit: PAGE } } });
      if (!data) return setError(problemMessage(problem));
      setItems((list) => [...list, ...data.items.filter((e) => !list.some((x) => x.id === e.id))]);
      setCursor(data.nextCursor);
    } catch {
      setError(errorMessage("network"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.section}>
      <Text style={styles.h2}>Expenses</Text>
      {items.length === 0 ? (
        <Card>
          <Text style={styles.muted}>No expenses yet. Add the first one above.</Text>
        </Card>
      ) : (
        items.map((e) => {
          const myShare = e.shares.find((s) => s.memberId === me.id)?.amountMinor ?? 0;
          const payer = e.payers.length === 1 ? nameOf(e.payers[0]!.memberId) : `${e.payers.length} people`;
          return (
            <Link key={e.id} href={`/groups/${groupId}/expenses/${e.id}`} asChild>
              <Pressable accessibilityRole="link">
                <Card>
                  <View style={styles.line}>
                    <View style={styles.grow}>
                      <Text style={styles.name} numberOfLines={1}>{e.description}</Text>
                      <Text style={styles.small}>
                        {e.occurredOn} · {payer} paid {formatMoney(e.amountMinor, e.currency)}
                      </Text>
                    </View>
                    <Text style={styles.muted}>{myShare > 0 ? `your share ${formatMoney(myShare, e.currency)}` : "not involved"}</Text>
                  </View>
                </Card>
              </Pressable>
            </Link>
          );
        })
      )}
      <ErrorBanner message={error} />
      {cursor && <Button title="Older expenses" variant="secondary" busy={busy} onPress={() => void more()} />}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { gap: space.sm },
  section: { gap: space.sm },
  line: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.md },
  grow: { flex: 1, gap: 2 },
  h2: { fontSize: font.lg, fontWeight: "600", color: colors.text },
  name: { fontSize: font.base, fontWeight: "500", color: colors.text },
  body: { fontSize: font.sm, color: colors.text },
  small: { fontSize: 12, color: colors.muted },
  muted: { fontSize: font.sm, color: colors.muted },
  caps: { fontSize: 12, fontWeight: "600", color: colors.muted, textTransform: "uppercase" },
  owed: { fontSize: font.sm, color: colors.owed },
  owes: { fontSize: font.sm, color: colors.owes },
});
