"use client";

import { exponent, formatMoney, parseMoney, toDecimalString } from "@kitty/money";
import Link from "next/link";
import { useState } from "react";
import { confirmTable, mapGuest, saveItems, saveTip, transition } from "@/app/groups/[id]/table/actions";
import { toggleClaim } from "@/app/t/[sessionId]/actions";
import { CopyButton } from "@/components/CopyButton";
import { useTableSession } from "@/hooks/useTableSession";
import { errorMessage } from "@/lib/errors";
import { rowsAction } from "@/lib/receipt-upload";
import { tipToMinor, type TableSession } from "@/lib/table-state";
import { ItemList, PreviewTotals } from "./ItemList";
import { ReceiptScan } from "./ReceiptScan";

type Member = { id: string; displayName: string };
type Row = { id: string; description: string; quantity: string; amount: string };
type Result = { session: TableSession | null; error: string | null };

/** The host's screen: enter the bill, show the QR code, watch claims arrive, match guests, confirm. */
export function HostTable({
  initial,
  groupId,
  members: initialMembers,
  hubUrl,
  link,
  qrDataUrl,
}: {
  initial: TableSession;
  groupId: string;
  members: Member[];
  hubUrl: string;
  link: string;
  qrDataUrl: string;
}) {
  const { session, apply } = useTableSession(initial, hubUrl, groupId);
  const exp = exponent(session.currency);
  const money = (minor: number) => formatMoney(minor, session.currency);
  const toRows = (items: TableSession["items"]): Row[] =>
    items.map((i) => ({ id: i.id, description: i.description, quantity: String(i.quantity), amount: toDecimalString(i.lineTotalMinor, exp) }));
  const [rows, setRows] = useState<Row[]>(() => toRows(initial.items));
  const [members, setMembers] = useState(initialMembers);
  const [tipMode, setTipMode] = useState<"percent" | "amount">("percent");
  const [tipInput, setTipInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const me = session.viewer.id;
  const open = session.status === "open";
  const active = open || session.status === "locked";
  const itemsTotal = session.items.reduce((sum, i) => sum + i.lineTotalMinor, 0);
  const chargesTotal = session.charges.reduce((sum, c) => sum + c.amountMinor, 0);
  const unclaimed = session.items.filter((i) => i.claimants.length === 0);
  const unmatchedGuests = session.guests.filter(
    (g) => !g.mappedMemberId && session.items.some((i) => i.claimants.some((c) => c.id === g.id)),
  );

  // What "Save items" would send, and whether it differs from what the table already has.
  const typed = rows
    .filter((r) => r.description.trim() || r.amount.trim())
    .map((r) => ({ id: r.id, description: r.description.trim(), quantity: Number(r.quantity) || 1, lineTotalMinor: parseMoney(r.amount, session.currency) ?? -1 }));
  // When the bill's items change elsewhere (a scan filled them), the rows follow, unless the host is editing.
  const itemsKey = JSON.stringify(session.items.map((i) => [i.id, i.description, i.quantity, i.lineTotalMinor]));
  const rowsKey = JSON.stringify(typed.map((i) => [i.id, i.description, i.quantity, i.lineTotalMinor]));
  const [rowsBuiltFrom, setRowsBuiltFrom] = useState(itemsKey);
  if (itemsKey !== rowsBuiltFrom) {
    if (rowsAction(rowsKey, rowsBuiltFrom, itemsKey) === "reset") setRows(toRows(session.items));
    setRowsBuiltFrom(itemsKey);
  }

  const unsaved =
    typed.length !== session.items.length ||
    typed.some((t, i) => {
      const saved = session.items[i];
      return !saved || saved.id !== t.id || saved.description !== t.description || saved.quantity !== t.quantity || saved.lineTotalMinor !== t.lineTotalMinor;
    });

  async function run(action: () => Promise<Result>) {
    setBusy(true);
    const result = await action();
    apply(result.session);
    setError(result.error ? (errorMessage(result.error) ?? "Something went wrong.") : null);
    setBusy(false);
  }

  function onSaveItems() {
    if (typed.some((i) => !i.description || i.lineTotalMinor < 0 || i.quantity < 1 || i.quantity > 99)) {
      setError("Each item needs a name, a quantity from 1 to 99 and a valid price.");
      return;
    }
    void run(() => saveItems(groupId, session.id, typed));
  }

  function onSaveTip() {
    const tip = tipToMinor(tipInput, tipMode, itemsTotal, session.currency);
    if (tip === null) {
      setError("Enter the tip as an amount or a percentage (0–100).");
      return;
    }
    void run(() => saveTip(groupId, session.id, tip));
  }

  function onMapGuest(guestId: string, guestName: string, choice: string) {
    void run(async () => {
      const result = choice === "__new" ? await mapGuest(groupId, session.id, guestId, null, guestName) : await mapGuest(groupId, session.id, guestId, choice || null, null);
      if (result.member) setMembers((current) => (current.some((m) => m.id === result.member!.id) ? current : [...current, result.member!]));
      return result;
    });
  }

  const setRow = (id: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm uppercase tracking-wide text-stone-500">You&apos;re running this table</p>
        <h1 className="text-2xl font-bold">{session.title}</h1>
        <p className="text-sm text-stone-500">
          Items {money(itemsTotal)} · extras {money(chargesTotal)} · total <strong>{money(itemsTotal + chargesTotal)}</strong>
        </p>
      </div>

      {session.status === "confirmed" && (
        <p role="status" className="rounded-xl bg-green-50 p-3 text-sm text-owed dark:bg-green-950">
          This bill has been split and added to the group.{" "}
          <Link href={`/groups/${groupId}`} className="font-semibold underline">Back to the group</Link>
        </p>
      )}
      {session.status === "cancelled" && (
        <p role="status" className="rounded-xl bg-stone-100 p-3 text-sm dark:bg-stone-800">
          This bill was cancelled. Nothing was recorded.{" "}
          <Link href={`/groups/${groupId}`} className="font-semibold underline">Back to the group</Link>
        </p>
      )}
      {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-owes dark:bg-red-950">{error}</p>}

      {open && <ReceiptScan session={session} groupId={groupId} busy={busy} run={(action) => void run(action)} />}

      <div className="card space-y-3">
        <h2 className="font-semibold">1. The bill</h2>
        <p className="text-xs text-stone-500">Prices as printed (VAT is already included in South Africa). Add tip or service charge below.</p>
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="grid grid-cols-[3rem_1fr_6rem_auto] gap-2">
              <input aria-label="Quantity" inputMode="numeric" className="field px-2 text-center" value={r.quantity} disabled={!open}
                onChange={(e) => setRow(r.id, { quantity: e.target.value })} />
              <input aria-label="Item" className="field" placeholder="Burger" maxLength={80} value={r.description} disabled={!open}
                onChange={(e) => setRow(r.id, { description: e.target.value })} />
              <input aria-label="Price" inputMode="decimal" className="field text-right" placeholder="0.00" value={r.amount} disabled={!open}
                onChange={(e) => setRow(r.id, { amount: e.target.value })} />
              <button type="button" aria-label="Remove item" disabled={!open} className="px-2 text-stone-400 hover:text-owes"
                onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}>×</button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary flex-1" disabled={!open}
            onClick={() => setRows((rs) => [...rs, { id: crypto.randomUUID(), description: "", quantity: "1", amount: "" }])}>
            Add item
          </button>
          <button type="button" className={unsaved ? "btn-primary flex-1" : "btn-secondary flex-1"} disabled={!open || busy || !unsaved} onClick={onSaveItems}>
            {unsaved ? "Save items" : "Items saved"}
          </button>
        </div>

        <div className="flex items-end gap-2 border-t border-stone-100 pt-3 dark:border-stone-800">
          <div className="flex-1">
            <label htmlFor="tip" className="label">Tip</label>
            <input id="tip" inputMode="decimal" className="field" placeholder={tipMode === "percent" ? "10" : "50.00"} value={tipInput}
              disabled={!open} onChange={(e) => setTipInput(e.target.value)} />
          </div>
          <select aria-label="Tip as" className="field w-24" value={tipMode} disabled={!open}
            onChange={(e) => setTipMode(e.target.value as "percent" | "amount")}>
            <option value="percent">%</option>
            <option value="amount">{session.currency}</option>
          </select>
          <button type="button" className="btn-secondary" disabled={!open || busy} onClick={onSaveTip}>Set tip</button>
        </div>
      </div>

      {active && (
        <div className="card flex flex-col items-center gap-3 text-center sm:flex-row sm:text-left">
          {/* A data: URL generated on the server, so next/image has nothing to optimise. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrDataUrl} alt="QR code to join this table" width={160} height={160} className="rounded-lg bg-white p-2" />
          <div className="min-w-0 space-y-2">
            <h2 className="font-semibold">2. Everyone scans and taps what they had</h2>
            <p className="text-sm text-stone-600 dark:text-stone-400">No account needed. Friends in the group are recognised when signed in.</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-stone-100 px-2 py-1.5 text-xs dark:bg-stone-800">{link}</code>
              <CopyButton text={link} />
            </div>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <h2 className="font-semibold">Live claims</h2>
        <ItemList session={session} meId={me} onToggle={open ? (itemId, claim) => void run(() => toggleClaim(session.id, groupId, itemId, claim)) : undefined} />
        {session.preview.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">{active ? "If you confirm now" : "The split"}</h3>
            <PreviewTotals session={session} meId={me} />
          </div>
        )}
        {active && session.preview.length > 0 && unclaimed.length > 0 && (
          <p className="text-sm text-stone-600 dark:text-stone-400">
            {unclaimed.length === 1 ? "1 item hasn't" : `${unclaimed.length} items haven't`} been claimed (
            {money(unclaimed.reduce((sum, i) => sum + i.lineTotalMinor, 0))}). Unclaimed items are split between everyone who tapped something.
          </p>
        )}
      </div>

      {active && session.guests.length > 0 && (
        <div className="card space-y-3">
          <h2 className="font-semibold">3. Who are the guests?</h2>
          <p className="text-xs text-stone-500">Match each guest to someone in the group (or add them) so their share lands on the right person.</p>
          <ul className="space-y-2">
            {session.guests.map((g) => (
              <li key={g.id} className="flex items-center gap-2">
                <span className="flex-1 truncate text-sm">{g.displayName}</span>
                <select aria-label={`Who is ${g.displayName}?`} className="field w-48 py-1.5" value={g.mappedMemberId ?? ""} disabled={busy}
                  onChange={(e) => onMapGuest(g.id, g.displayName, e.target.value)}>
                  <option value="">Not matched yet</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
                  <option value="__new">Add “{g.displayName}” to the group</option>
                </select>
              </li>
            ))}
          </ul>
        </div>
      )}

      {active && (
        <div className="space-y-2">
          {session.preview.length === 0 && <p className="text-sm text-stone-500">Nobody has tapped anything yet, so there is nothing to split.</p>}
          {unmatchedGuests.length > 0 && (
            <p className="text-sm text-stone-500">
              Match {unmatchedGuests.map((g) => g.displayName).join(", ")} to someone in the group before confirming.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            {open ? (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => void run(() => transition(groupId, session.id, "lock"))}>
                Lock the bill
              </button>
            ) : (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => void run(() => transition(groupId, session.id, "unlock"))}>
                Unlock
              </button>
            )}
            <button type="button" className="btn-primary" disabled={busy || session.preview.length === 0 || unmatchedGuests.length > 0}
              onClick={() => void run(() => confirmTable(groupId, session.id))}>
              Confirm and split
            </button>
            <button type="button" className="col-span-2 text-sm text-stone-500 hover:text-owes" disabled={busy}
              onClick={() => void run(() => transition(groupId, session.id, "cancel"))}>
              Cancel this bill
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
