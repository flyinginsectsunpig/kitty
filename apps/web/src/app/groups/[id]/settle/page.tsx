import type { OpenItem } from "@kitty/core";
import { formatMoney } from "@kitty/money";
import { ConfirmButton } from "@/components/ConfirmButton";
import { CopyButton } from "@/components/CopyButton";
import { CoversPicker } from "@/components/CoversPicker";
import { ForeignSettleFields } from "@/components/ForeignSettleFields";
import { ErrorBanner } from "@/components/ErrorBanner";
import { GroupNav } from "@/components/GroupNav";
import { dayMonth } from "@/lib/day-month";
import { loadGroup } from "@/lib/group-context";
import { unwrap } from "@/lib/ledger";
import { deleteSettlement, fetchRate, recordSettlement, remindMember } from "../actions";

export default async function SettlePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; settled?: string; reminded?: string; deleted?: string }>;
}) {
  const { id } = await params;
  const { error, settled, reminded, deleted } = await searchParams;
  const { ledger, group, me, nameOf } = await loadGroup(id);
  const [balances, recent] = await Promise.all([
    ledger.GET("/groups/{groupId}/balances", { params: { path: { groupId: id } } }).then(unwrap),
    // Recent payments are extra: if they can't be loaded, the section is left out and the transfers still show.
    ledger
      .GET("/groups/{groupId}/settlements", { params: { path: { groupId: id }, query: { limit: 20 } } })
      .then((r) => r.data ?? [])
      .catch(() => []),
  ]);
  const detailsOf = new Map(group.members.map((m) => [m.id, m.paymentDetails]));

  const transfers = balances.currencies
    .flatMap((c) => c.transfers.map((t) => ({ ...t, currency: c.currency })))
    // Your own payments first, then ones you are owed, then everyone else's.
    .sort((a, b) => rank(a) - rank(b));
  const firstOwedTo = new Map<string, (typeof transfers)[number]>();
  for (const t of transfers) if (t.toMemberId === me.id && !firstOwedTo.has(t.fromMemberId)) firstOwedTo.set(t.fromMemberId, t);
  function rank(t: { fromMemberId: string; toMemberId: string }) {
    return t.fromMemberId === me.id ? 0 : t.toMemberId === me.id ? 1 : 2;
  }

  // What each payer still owes each receiver item by item, in the transfer's currency, for the ticks. The ticks are
  // optional: if the ledger can't list the items, the transfer is marked as paid without them, as before.
  const openFor = await Promise.all(
    transfers.map(async (t): Promise<OpenItem[]> => {
      const open = await ledger
        .GET("/groups/{groupId}/open-items", {
          params: { path: { groupId: id }, query: { from: t.fromMemberId, to: t.toMemberId } },
        })
        .then((r) => r.data)
        .catch(() => undefined);
      return (open?.currencies.find((c) => c.currency === t.currency)?.fromOwes ?? []).map((o) => ({
        expenseId: o.item.expenseId,
        description: o.item.description,
        date: o.item.date,
        openMinor: o.open.minor,
      }));
    }),
  );

  return (
    <section className="space-y-6">
      <GroupNav groupId={id} groupName={group.name} active="/settle" />
      <ErrorBanner code={error} />
      {settled && <p className="rounded-xl bg-green-50 p-3 text-sm text-owed dark:bg-green-950">Payment recorded.</p>}
      {reminded && <p className="rounded-xl bg-green-50 p-3 text-sm text-owed dark:bg-green-950">Reminder sent.</p>}
      {deleted && <p className="rounded-xl bg-green-50 p-3 text-sm text-owed dark:bg-green-950">Payment deleted.</p>}

      {transfers.length === 0 ? (
        <p className="card text-center text-stone-600 dark:text-stone-400">Everyone is settled up. 🎉</p>
      ) : (
        <>
          <p className="text-sm text-stone-600 dark:text-stone-400">
            The fewest payments that settle everyone. Pay outside Kitty, then mark it as paid.
          </p>
          <ul className="space-y-3">
            {transfers.map((t, n) => {
              const items = openFor[n] ?? [];
              const from = t.fromMemberId === me.id ? "You" : nameOf(t.fromMemberId);
              const to = t.toMemberId === me.id ? "you" : nameOf(t.toMemberId);
              const details = detailsOf.get(t.toMemberId);
              return (
                <li key={`${t.currency}-${t.fromMemberId}-${t.toMemberId}`} className="card space-y-3">
                  <p className="text-base">
                    <strong>{from}</strong> {t.fromMemberId === me.id ? "pay" : "pays"} <strong>{to}</strong>{" "}
                    <span className="font-semibold tabular-nums">{formatMoney(t.amountMinor, t.currency)}</span>
                  </p>
                  {t.toMemberId !== me.id &&
                    (details ? (
                      <div className="flex items-start gap-2">
                        <p className="flex-1 whitespace-pre-wrap rounded-lg bg-stone-100 p-2 text-sm dark:bg-stone-800">{details}</p>
                        <CopyButton text={details} />
                      </div>
                    ) : (
                      <p className="text-xs text-stone-500">{nameOf(t.toMemberId)} hasn&apos;t added payment details yet.</p>
                    ))}
                  <form action={recordSettlement}>
                    <input type="hidden" name="groupId" value={id} />
                    <input type="hidden" name="settlementId" value={crypto.randomUUID()} />
                    <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
                    <input type="hidden" name="fromMemberId" value={t.fromMemberId} />
                    <input type="hidden" name="toMemberId" value={t.toMemberId} />
                    <input type="hidden" name="currency" value={t.currency} />
                    <input type="hidden" name="amountMinor" value={t.amountMinor} />
                    {t.currency !== group.baseCurrency && (
                      <div className="mb-3">
                        <ForeignSettleFields groupId={id} currency={t.currency} groupCurrency={group.baseCurrency}
                          amountMinor={t.amountMinor} fetchRate={fetchRate} />
                      </div>
                    )}
                    {items.length > 0 && (
                      <div className="mb-3">
                        <CoversPicker items={items} amountMinor={t.amountMinor} currency={t.currency} />
                      </div>
                    )}
                    <button className="btn-primary w-full">Mark as paid</button>
                  </form>
                  {/* Someone who owes you: one Remind per person (their first payment to you in the list). */}
                  {t.toMemberId === me.id && firstOwedTo.get(t.fromMemberId) === t && (
                    <form action={remindMember}>
                      <input type="hidden" name="groupId" value={id} />
                      <input type="hidden" name="memberId" value={t.fromMemberId} />
                      <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
                      <button className="btn-secondary w-full">Remind {nameOf(t.fromMemberId)}</button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {recent.length > 0 && (
        <div className="space-y-3">
          <h2 className="font-semibold">Recent payments</h2>
          <ul className="space-y-2">
            {recent.map((r) => {
              const p = r.payment;
              const from = p.fromMemberId === me.id ? "You" : r.from;
              const to = p.toMemberId === me.id ? "you" : r.to;
              const what = r.covers.map((c) => c.description).join(", ");
              const money = formatMoney(p.amountMinor, p.currency);
              return (
                <li key={p.id} className="card flex items-center justify-between gap-3">
                  <p className="text-sm">
                    {from} paid {to} <span className="tabular-nums">{money}</span> ·{" "}
                    {dayMonth(r.date)}
                    {what && ` · for: ${what}`}
                  </p>
                  <form action={deleteSettlement}>
                    <input type="hidden" name="groupId" value={id} />
                    <input type="hidden" name="settlementId" value={p.id} />
                    <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
                    <ConfirmButton
                      className="btn-secondary shrink-0 text-xs"
                      label={`Delete payment: ${from} paid ${to} ${money}`}
                      question="Delete this payment? Its items go back on the list."
                    >
                      Delete
                    </ConfirmButton>
                  </form>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
