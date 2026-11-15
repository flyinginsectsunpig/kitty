import { formatMoney } from "@kitty/money";
import Link from "next/link";
import { getLedger, unwrap } from "@/lib/ledger";

export default async function GroupsPage() {
  const ledger = await getLedger();
  const groups = unwrap(await ledger.GET("/groups"));

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Your groups</h1>
        <Link href="/groups/new" className="btn-primary">New group</Link>
      </div>

      {groups.length === 0 ? (
        <div className="card text-center text-stone-600 dark:text-stone-400">
          <p>No groups yet. Start one for your flat, a trip or a dinner.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {groups.map((g) => (
            <li key={g.id}>
              <Link href={`/groups/${g.id}`} className="card flex items-center justify-between hover:border-brand-500">
                <div>
                  <p className="font-semibold">{g.name}</p>
                  <p className="text-sm text-stone-500">
                    {g.memberCount} {g.memberCount === 1 ? "person" : "people"}
                  </p>
                </div>
                <div className="text-right text-sm">
                  {g.myNet.length === 0 ? (
                    <span className="text-stone-500">Settled up</span>
                  ) : (
                    g.myNet.map((n) => (
                      <p key={n.currency} className={n.netMinor > 0 ? "text-owed" : "text-owes"}>
                        {n.netMinor > 0 ? "You're owed " : "You owe "}
                        {formatMoney(Math.abs(n.netMinor), n.currency)}
                      </p>
                    ))
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
