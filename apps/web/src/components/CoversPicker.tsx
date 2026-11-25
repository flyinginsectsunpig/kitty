"use client";

import { allocateCovers, draftMoney, type OpenItem } from "@kitty/core";
import { useState } from "react";
import { dayMonth } from "@/lib/day-month";

/**
 * Settle up's "What it covers": the open items from the payer to the receiver, none ticked. The ticked items are sent
 * with Mark as paid as repeated "cover" fields ("expenseId:amountMinor"), oldest first, up to the payment's amount.
 */
export function CoversPicker({ items, amountMinor, currency }: { items: OpenItem[]; amountMinor: number; currency: string }) {
  // The ticks are kept as ticked, not read back from the covers: an item the amount doesn't reach stays ticked.
  const [ticked, setTicked] = useState<string[]>([]);
  const { covers } = allocateCovers(items, ticked, amountMinor);
  const last = covers.at(-1);
  const lastItem = last && items.find((i) => i.expenseId === last.expenseId);
  const partly = last && lastItem && last.amountMinor < lastItem.openMinor ? { cover: last, item: lastItem } : null;

  const toggle = (id: string) => setTicked((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));

  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-stone-600 dark:text-stone-400">What it covers</summary>
      {covers.map((c) => (
        <input key={c.expenseId} type="hidden" name="cover" value={`${c.expenseId}:${c.amountMinor}`} />
      ))}
      <ul className="mt-2 space-y-1">
        {items.map((i) => (
          <li key={i.expenseId}>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4 accent-brand-600"
                checked={ticked.includes(i.expenseId)}
                onChange={() => toggle(i.expenseId)}
              />
              <span>
                {i.description} · {dayMonth(i.date)} · <span className="tabular-nums">{draftMoney(i.openMinor, currency)}</span> open
              </span>
            </label>
          </li>
        ))}
      </ul>
      {partly && (
        <p className="mt-2 text-stone-600 dark:text-stone-400">
          {partly.item.description}: <span className="tabular-nums">{draftMoney(partly.cover.amountMinor, currency)}</span> of{" "}
          <span className="tabular-nums">{draftMoney(partly.item.openMinor, currency)}</span>
        </p>
      )}
    </details>
  );
}
