import { useCallback, useState } from "react";
import { Share, StyleSheet, Text, View } from "react-native";
import { Button } from "../../../../components/Button";
import { CopyButton } from "../../../../components/CopyButton";
import { ErrorBanner } from "../../../../components/ErrorBanner";
import { GroupNav } from "../../../../components/GroupNav";
import { Card, Screen } from "../../../../components/Screen";
import { TextField } from "../../../../components/TextField";
import { config } from "../../../../config";
import { useGroup } from "../../../../group/GroupContext";
import { useAction } from "../../../../hooks/useAction";
import { useLedger } from "../../../../ledger";
import { colors, font, radius, space } from "../../../../theme";

export default function MembersScreen() {
  const { group, me, reload } = useGroup();
  const [invite, setInvite] = useState<string | null>(null);

  return (
    <Screen onRefresh={() => void reload()}>
      <GroupNav groupId={group.id} active="/members" />
      {invite && <InviteReady url={invite} />}

      <Card>
        {group.members.map((m) => (
          <View key={m.id} style={styles.member}>
            <View style={styles.grow}>
              <Text style={styles.name}>
                {m.displayName} {m.id === me.id && <Text style={styles.muted}>(you)</Text>}
              </Text>
              {m.isPlaceholder && <Text style={styles.small}>Not on Kitty yet</Text>}
            </View>
            {m.isPlaceholder && (
              <InviteButton label={`Invite ${m.displayName}`} title="Invite" memberId={m.id} onCreated={setInvite} groupId={group.id} />
            )}
          </View>
        ))}
      </Card>

      <AddPerson />

      <Card>
        <Text style={styles.label}>Invite someone new</Text>
        <Text style={styles.small}>Creates a one-time link that adds a new person to the group.</Text>
        <InviteButton label="Create invite link" title="Create invite link" memberId={null} onCreated={setInvite} groupId={group.id} />
      </Card>

      <MyDetails />
    </Screen>
  );
}

/** One invite request, for a placeholder or for someone new. Shares the link as soon as it exists. */
function InviteButton({ label, title, memberId, onCreated, groupId }: { label: string; title: string; memberId: string | null; onCreated: (url: string) => void; groupId: string }) {
  const ledger = useLedger();
  const create = useAction(
    useCallback(
      (key: string) => ledger.POST("/groups/{groupId}/invites", { params: { path: { groupId } }, body: { memberId }, headers: { "Idempotency-Key": key } }),
      [ledger, groupId, memberId],
    ),
  );
  async function onPress() {
    const r = await create.run();
    if (!r.ok || !r.data) return;
    const url = `${config.webUrl}/invite/${encodeURIComponent(r.data.token)}`;
    onCreated(url);
    await Share.share({ message: `Join me on Kitty to split costs: ${url}` }).catch(() => {});
  }
  return (
    <View style={styles.inviteButton}>
      <ErrorBanner message={create.error} />
      <Button title={title} accessibilityLabel={label} variant="secondary" busy={create.busy} onPress={() => void onPress()} />
    </View>
  );
}

function InviteReady({ url }: { url: string }) {
  return (
    <Card>
      <Text style={styles.name}>Invite link ready</Text>
      <Text style={styles.small}>Send it to one person. It works once and expires in 7 days.</Text>
      <View style={styles.row}>
        <View style={styles.code}>
          <Text style={styles.codeText} numberOfLines={1} ellipsizeMode="middle">
            {url}
          </Text>
        </View>
        <CopyButton text={url} />
      </View>
      <Button title="Share link" variant="secondary" onPress={() => void Share.share({ message: `Join me on Kitty to split costs: ${url}` }).catch(() => {})} />
    </Card>
  );
}

function AddPerson() {
  const ledger = useLedger();
  const { group, reload } = useGroup();
  const [name, setName] = useState("");
  const add = useAction(
    useCallback(
      (key: string) => ledger.POST("/groups/{groupId}/members", { params: { path: { groupId: group.id } }, body: { displayName: name.trim() }, headers: { "Idempotency-Key": key } }),
      [ledger, group.id, name],
    ),
  );
  async function onAdd() {
    if (!name.trim()) return add.setError("Type their name first.");
    if ((await add.run()).ok) {
      setName("");
      await reload();
    }
  }
  return (
    <Card>
      <ErrorBanner message={add.error} />
      <TextField label="Add someone by name" value={name} onChangeText={setName} maxLength={40} placeholder="Gran, Sam…" />
      <Text style={styles.small}>They can join later and take over everything recorded for them.</Text>
      <Button title="Add person" variant="secondary" busy={add.busy} onPress={() => void onAdd()} />
    </Card>
  );
}

function MyDetails() {
  const ledger = useLedger();
  const { group, me, reload } = useGroup();
  const [displayName, setDisplayName] = useState(me.displayName);
  const [paymentDetails, setPaymentDetails] = useState(me.paymentDetails ?? "");
  const [saved, setSaved] = useState(false);
  const save = useAction(
    useCallback(
      (key: string) =>
        ledger.PATCH("/groups/{groupId}/members/{memberId}", {
          params: { path: { groupId: group.id, memberId: me.id } },
          body: { displayName: displayName.trim(), paymentDetails },
          headers: { "Idempotency-Key": key },
        }),
      [ledger, group.id, me.id, displayName, paymentDetails],
    ),
  );
  async function onSave() {
    setSaved(false);
    if (!displayName.trim()) return save.setError("Your name can't be empty.");
    if ((await save.run()).ok) {
      setSaved(true);
      void reload();
    }
  }
  return (
    <Card>
      <Text style={styles.h2}>Your details in this group</Text>
      {saved && <Text style={styles.saved}>Saved.</Text>}
      <ErrorBanner message={save.error} />
      <TextField label="Name shown to the group" value={displayName} onChangeText={setDisplayName} maxLength={40} />
      <TextField
        label="How people pay you back"
        value={paymentDetails}
        onChangeText={setPaymentDetails}
        maxLength={500}
        multiline
        placeholder="PayShap ID, bank name and account number, or a payment link"
      />
      <Text style={styles.small}>Only people in this group can see this. Kitty never moves money.</Text>
      <Button title="Save" busy={save.busy} onPress={() => void onSave()} />
    </Card>
  );
}

const styles = StyleSheet.create({
  member: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.xs },
  grow: { flex: 1, gap: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm },
  inviteButton: { gap: space.xs },
  h2: { fontSize: font.lg, fontWeight: "600", color: colors.text },
  name: { fontSize: font.base, fontWeight: "500", color: colors.text },
  label: { fontSize: font.sm, fontWeight: "500", color: colors.muted },
  muted: { fontSize: font.sm, color: colors.muted, fontWeight: "400" },
  small: { fontSize: 12, color: colors.muted },
  saved: { fontSize: font.sm, color: colors.owed },
  // One line, cut in the middle (Copy has the full link). Not `selectable`: on Android that ignores numberOfLines.
  code: { flex: 1, backgroundColor: "#f5f5f4", borderRadius: radius.field, padding: space.sm },
  codeText: { fontSize: 12, color: colors.text },
});
