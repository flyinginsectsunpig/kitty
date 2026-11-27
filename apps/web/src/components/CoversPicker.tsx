"use client";

import { allocateCovers, coverLines, coverNote, draftMoney, type OpenItem } from "@kitty/core";
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
  // Before saving, say what a ticked item doesn't get: part of what's open, or nothing once the payment runs out.
  const notes = coverLines(items, ticked, covers)
    .map((l) => ({ id: l.expenseId, text: coverNote(l, currency) }))
    .filter((n) => n.text !== null);

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
      {notes.map((n) => (
        <p key={n.id} className="mt-2 tabular-nums text-stone-600 dark:text-stone-400">
          {n.text}
        </p>
      ))}
    </details>
  );
}
