import { formatMoney, isSupported } from "@kitty/money";
import { GroupNav } from "@/components/GroupNav";
import { loadGroup } from "@/lib/group-context";
import { unwrap } from "@/lib/ledger";

type Snapshot = { description?: string; displayName?: string; name?: string; amountMinor?: number; currency?: string } | null;

function describe(entityType: string, snapshot: Snapshot): string {
  if (!snapshot) return entityType;
  const amount =
    typeof snapshot.amountMinor === "number" && snapshot.currency && isSupported(snapshot.currency)
      ? ` (${formatMoney(snapshot.amountMinor, snapshot.currency)})`
      : "";
  switch (entityType) {
    case "expense":
      return `expense "${snapshot.description ?? ""}"${amount}`;
    case "settlement":
      return `a payment${amount}`;
    case "member":
      return `${snapshot.displayName ?? "a person"}`;
    case "group":
      return `the group${snapshot.name ? ` "${snapshot.name}"` : ""}`;
    default:
      return entityType;
  }
}

export default async function ActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ledger, group } = await loadGroup(id);
  const feed = unwrap(await ledger.GET("/groups/{groupId}/activity", { params: { path: { groupId: id }, query: { limit: 100 } } }));

  return (
    <section className="space-y-6">
      <GroupNav groupId={id} groupName={group.name} active="/activity" />
      <ol className="card divide-y divide-stone-100 p-0 dark:divide-stone-800">
        {feed.map((a) => (
          <li key={a.id} className="px-4 py-3 text-sm">
            <p>
              <strong>{a.actorDisplayName}</strong> {a.action} {describe(a.entityType, (a.after ?? a.before) as Snapshot)}
            </p>
            <time className="text-xs text-stone-500" dateTime={a.at}>
              {new Date(a.at).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })}
            </time>
          </li>
        ))}
      </ol>
    </section>
  );
}
