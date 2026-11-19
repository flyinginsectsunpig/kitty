"use client";

import { formatMoney } from "@kitty/money";
import { useState } from "react";
import { toggleClaim } from "@/app/t/[sessionId]/actions";
import { useTableSession } from "@/hooks/useTableSession";
import { errorMessage } from "@/lib/errors";
import { myShare, type TableSession } from "@/lib/table-state";
import { ItemList, PreviewTotals } from "./ItemList";

type Phase = "open" | "locked" | "settled" | "cancelled" | "closed";

/** The screen everyone at the table uses: tap what you had, watch everyone else's taps arrive live. */
export function ClaimTable({ initial, groupId, hubUrl }: { initial: TableSession; groupId: string | null; hubUrl: string }) {
  const { session, closed, apply } = useTableSession(initial, hubUrl, groupId);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const me = session.viewer.id;
  const payer = session.payerDisplayName;
  const money = (minor: number) => formatMoney(minor, session.currency);

  // `closed` is set when this viewer can no longer fetch the bill (a guest, once it is confirmed or cancelled).
  const phase: Phase = closed
    ? closed.how === "confirmed" ? "settled" : closed.how === "cancelled" ? "cancelled" : "closed"
    : session.status === "confirmed" ? "settled"
      : session.status === "cancelled" ? "cancelled"
        : session.status === "locked" ? "locked" : "open";

  const soFar = myShare(session);
  // The server's split for me in the last view we hold. It is the final amount once the bill is locked or
  // settled, unless we lost access before seeing the final version.
  const lastSplit = session.preview.find((p) => p.id === me)?.amountMinor ?? 0;
  const finalAmount = (phase === "locked" || phase === "settled") && (closed === null || closed.finalKnown) ? lastSplit : null;

  async function onToggle(itemId: string, claim: boolean) {
    setBusy(itemId);
    const result = await toggleClaim(session.id, groupId, itemId, claim);
    apply(result.session);
    setError(errorMessage(result.error ?? undefined));
    setBusy(null);
  }

  return (
    <section className="space-y-4 pb-24">
      <div>
        <p className="text-sm uppercase tracking-wide text-stone-500">Splitting the bill</p>
        <h1 className="text-2xl font-bold">{session.title}</h1>
      </div>

      {phase === "settled" && (
        <div role="status" className="rounded-xl bg-green-50 p-3 text-sm text-owed dark:bg-green-950">
          <p className="font-semibold">Done. The bill has been split.</p>
          {finalAmount === null ? (
            <p>Ask {payer} for your final amount.</p>
          ) : session.payerMemberId === me ? (
            <p>You paid the bill. Everyone else now owes you their share.</p>
          ) : finalAmount === 0 ? (
            <p>You don&apos;t owe anything for this bill.</p>
          ) : (
            <p>
              Your share is <strong>{money(finalAmount)}</strong>. Pay {payer}.
            </p>
          )}
        </div>
      )}
      {phase === "cancelled" && (
        <p role="status" className="rounded-xl bg-stone-100 p-3 text-sm dark:bg-stone-800">
          The host cancelled this bill. Nothing was recorded.
        </p>
      )}
      {phase === "closed" && (
        <p role="status" className="rounded-xl bg-stone-100 p-3 text-sm dark:bg-stone-800">
          This bill is closed. Ask {payer} if you still owe anything.
        </p>
      )}
      {phase === "locked" && (
        <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm dark:bg-amber-950">
          The host has locked the bill and is about to confirm it.
        </p>
      )}
      {error && <p role="alert" className="text-sm text-owes">{error}</p>}

      {phase === "open" && <p className="text-sm text-stone-600 dark:text-stone-400">Tap everything you had. Tap again to undo.</p>}
      <ItemList session={session} meId={me} onToggle={phase === "open" ? onToggle : undefined} busyItemId={busy} />

      {phase === "open" && soFar.unclaimedMinor > 0 && (
        <p className="text-sm text-stone-600 dark:text-stone-400">
          {money(soFar.unclaimedMinor)} hasn&apos;t been claimed yet. Whatever is still unclaimed when the host confirms is
          split between everyone who tapped something.
        </p>
      )}

      {finalAmount !== null && session.preview.length > 0 && (
        <div className="space-y-2">
          <h2 className="font-semibold">The split</h2>
          <PreviewTotals session={session} meId={me} />
        </div>
      )}

      {(phase === "open" || finalAmount !== null) && (
        <div className="fixed inset-x-0 bottom-0 border-t border-stone-200 bg-white/95 backdrop-blur dark:border-stone-800 dark:bg-stone-950/95">
          <div className="mx-auto flex max-w-xl items-center justify-between px-4 py-3">
            <span className="text-sm text-stone-600 dark:text-stone-400">{phase === "open" ? "Your share so far" : "Your share"}</span>
            <span className="text-xl font-bold tabular-nums">{money(finalAmount ?? soFar.minor)}</span>
          </div>
        </div>
      )}
    </section>
  );
}
