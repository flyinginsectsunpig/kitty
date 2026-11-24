import { expenseAmounts } from "@kitty/core";
import { formatMoney } from "@kitty/money";
import Link from "next/link";
import { GroupNav } from "@/components/GroupNav";
import { loadGroup } from "@/lib/group-context";
import { unwrap } from "@/lib/ledger";

export default async function GroupPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { id } = await params;
  const { cursor } = await searchParams;
  const { ledger, group, me, nameOf } = await loadGroup(id);
  const [balances, page, tables] = await Promise.all([
    ledger.GET("/groups/{groupId}/balances", { params: { path: { groupId: id } } }).then(unwrap),
    ledger.GET("/groups/{groupId}/expenses", { params: { path: { groupId: id }, query: { cursor, limit: 30 } } }).then(unwrap),
    ledger.GET("/groups/{groupId}/table-sessions", { params: { path: { groupId: id } } }).then(unwrap),
  ]);

  return (
    <section className="space-y-6">
      <GroupNav groupId={id} groupName={group.name} active="" />

      <div className="grid grid-cols-2 gap-2">
        <Link href={`/groups/${id}/expenses/new`} className="btn-primary text-base">
          Add an expense
        </Link>
        <Link href={`/groups/${id}/table/new`} className="btn-secondary text-base">
          Split a bill at the table
        </Link>
      </div>

      {tables.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-semibold">Bills being split</h2>
          <ul className="space-y-2">
            {tables.map((t) => (
              <li key={t.id}>
                {/* The host goes back to running the bill; anyone else to claiming on it. */}
                <Link href={t.hostedByMe ? `/groups/${id}/table/${t.id}` : `/t/${t.id}?g=${id}`}
                  className="card flex items-center justify-between gap-3 hover:border-brand-500">
                  <span className="min-w-0 truncate font-medium">{t.title}</span>
                  <span className="shrink-0 text-sm text-stone-500">
                    {t.status === "locked" ? "locked" : "open"} · {t.hostedByMe ? "you're hosting" : "tap what you had"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card space-y-3">
        <h2 className="font-semibold">Balances</h2>
        {balances.converted && (
          <div className="space-y-2 rounded-xl bg-stone-50 p-3 dark:bg-stone-900">
            <p className="text-xs font-semibold uppercase text-stone-500">About {balances.converted.currency} in total</p>
            <ul className="divide-y divide-stone-100 dark:divide-stone-800">
              {balances.converted.members.filter((m) => m.netMinor !== 0).map((m) => (
                <li key={m.memberId} className="flex justify-between py-1.5 text-sm">
                  <span>{m.memberId === me.id ? "You" : nameOf(m.memberId)}</span>
                  <span className={m.netMinor > 0 ? "text-owed" : "text-owes"}>
                    {`${m.netMinor > 0 ? "gets back about" : "owes about"} ${formatMoney(Math.abs(m.netMinor), balances.converted!.currency)}`}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-stone-500">
              Uses each expense&apos;s saved exchange rate. Settle up in each currency below.
              {balances.converted.excludedCount > 0 &&
                ` ${balances.converted.excludedCount} older ${balances.converted.excludedCount === 1 ? "expense has" : "expenses have"} no rate yet.`}
            </p>
          </div>
        )}
        {balances.currencies.length === 0 ? (
          <p className="text-sm text-stone-500">Nothing to settle yet.</p>
        ) : (
          balances.currencies.map((c) => (
            <div key={c.currency} className="space-y-2">
              {balances.currencies.length > 1 && <p className="text-xs font-semibold uppercase text-stone-500">{c.currency}</p>}
              <ul className="divide-y divide-stone-100 dark:divide-stone-800">
                {c.members.map((m) => (
                  <li key={m.memberId} className="flex justify-between py-1.5 text-sm">
                    <span>{m.memberId === me.id ? "You" : nameOf(m.memberId)}</span>
                    <span className={m.netMinor > 0 ? "text-owed" : m.netMinor < 0 ? "text-owes" : "text-stone-500"}>
                      {m.netMinor === 0
                        ? "settled"
                        : `${m.netMinor > 0 ? "gets back" : "owes"} ${formatMoney(Math.abs(m.netMinor), c.currency)}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
        {balances.currencies.some((c) => c.transfers.length > 0) && (
          <Link href={`/groups/${id}/settle`} className="btn-secondary w-full">
            See the simplest way to settle up
          </Link>
        )}
      </div>

      <div className="space-y-2">
        <h2 className="font-semibold">Expenses</h2>
        {page.items.length === 0 ? (
          <p className="card text-sm text-stone-500">No expenses yet. Add the first one above.</p>
        ) : (
          <ul className="space-y-2">
            {page.items.map((e) => {
              const myShare = e.shares.find((s) => s.memberId === me.id)?.amountMinor ?? 0;
              const payer = e.payers.length === 1 ? nameOf(e.payers[0]!.memberId) : `${e.payers.length} people`;
              return (
                <li key={e.id}>
                  <Link href={`/groups/${id}/expenses/${e.id}/edit`} className="card flex items-center justify-between gap-3 hover:border-brand-500">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{e.description}</p>
                      <p className="text-xs text-stone-500">
                        {e.occurredOn} · {payer} paid {expenseAmounts(e, group.baseCurrency)}
                      </p>
                    </div>
                    <p className="shrink-0 text-right text-sm text-stone-600 dark:text-stone-400">
                      {myShare > 0 ? `your share ${formatMoney(myShare, e.currency)}` : "not involved"}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {page.nextCursor && (
          <Link href={`/groups/${id}?cursor=${encodeURIComponent(page.nextCursor)}`} className="btn-secondary w-full">
            Older expenses
          </Link>
        )}
      </div>
    </section>
  );
}
