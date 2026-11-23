import { describeActivity, type ActivitySnapshot } from "@kitty/core";
import { GroupNav } from "@/components/GroupNav";
import { loadGroup } from "@/lib/group-context";
import { unwrap } from "@/lib/ledger";

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
              <strong>{a.actorDisplayName}</strong> {a.action} {describeActivity(a.entityType, (a.after ?? a.before) as ActivitySnapshot)}
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
