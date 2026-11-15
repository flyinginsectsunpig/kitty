import { CopyButton } from "@/components/CopyButton";
import { ErrorBanner } from "@/components/ErrorBanner";
import { GroupNav } from "@/components/GroupNav";
import { loadGroup } from "@/lib/group-context";
import { addPlaceholder, createInvite, updateMyDetails } from "../actions";

export default async function MembersPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; invite?: string; saved?: string }>;
}) {
  const { id } = await params;
  const { error, invite, saved } = await searchParams;
  const { group, me } = await loadGroup(id);
  const inviteUrl = invite ? `${process.env.AUTH_URL ?? ""}/invite/${encodeURIComponent(invite)}` : null;

  return (
    <section className="space-y-6">
      <GroupNav groupId={id} groupName={group.name} active="/members" />
      <ErrorBanner code={error} />

      {inviteUrl && (
        <div className="card space-y-2 border-brand-500">
          <p className="font-semibold">Invite link ready</p>
          <p className="text-sm text-stone-600 dark:text-stone-400">Send it to one person. It works once and expires in 7 days.</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-stone-100 px-2 py-1.5 text-xs dark:bg-stone-800">{inviteUrl}</code>
            <CopyButton text={inviteUrl} />
          </div>
        </div>
      )}

      <ul className="card divide-y divide-stone-100 p-0 dark:divide-stone-800">
        {group.members.map((m) => (
          <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div>
              <p className="font-medium">
                {m.displayName} {m.id === me.id && <span className="text-sm text-stone-500">(you)</span>}
              </p>
              {m.isPlaceholder && <p className="text-xs text-stone-500">Not on Kitty yet</p>}
            </div>
            {m.isPlaceholder && (
              <form action={createInvite}>
                <input type="hidden" name="groupId" value={id} />
                <input type="hidden" name="memberId" value={m.id} />
                <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
                <button className="btn-secondary px-3 py-1.5">Invite</button>
              </form>
            )}
          </li>
        ))}
      </ul>

      <div className="grid gap-3 sm:grid-cols-2">
        <form action={addPlaceholder} className="card space-y-3">
          <input type="hidden" name="groupId" value={id} />
          <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
          <label htmlFor="displayName" className="label">Add someone by name</label>
          <input id="displayName" name="displayName" required maxLength={40} placeholder="Gran, Sam…" className="field" />
          <p className="text-xs text-stone-500">They can join later and take over everything recorded for them.</p>
          <button className="btn-secondary w-full">Add person</button>
        </form>
        <form action={createInvite} className="card flex flex-col justify-between gap-3">
          <input type="hidden" name="groupId" value={id} />
          <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
          <div>
            <p className="label">Invite someone new</p>
            <p className="text-xs text-stone-500">Creates a one-time link that adds a new person to the group.</p>
          </div>
          <button className="btn-secondary w-full">Create invite link</button>
        </form>
      </div>

      <form action={updateMyDetails} className="card space-y-3">
        <input type="hidden" name="groupId" value={id} />
        <input type="hidden" name="memberId" value={me.id} />
        <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
        <h2 className="font-semibold">Your details in this group</h2>
        {saved && <p className="text-sm text-owed">Saved.</p>}
        <div>
          <label htmlFor="myName" className="label">Name shown to the group</label>
          <input id="myName" name="displayName" required maxLength={40} defaultValue={me.displayName} className="field" />
        </div>
        <div>
          <label htmlFor="paymentDetails" className="label">How people pay you back</label>
          <textarea id="paymentDetails" name="paymentDetails" maxLength={500} rows={3} defaultValue={me.paymentDetails ?? ""}
            placeholder="PayShap ID, bank name and account number, or a payment link" className="field" />
          <p className="mt-1 text-xs text-stone-500">Only people in this group can see this. Kitty never moves money.</p>
        </div>
        <button className="btn-primary w-full">Save</button>
      </form>
    </section>
  );
}
