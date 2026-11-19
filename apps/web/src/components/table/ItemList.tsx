import { formatMoney } from "@kitty/money";
import type { TableSession } from "@/lib/table-state";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/**
 * The bill's lines with who claimed each one. When `onToggle` is given, rows are big tap targets that
 * claim or un-claim for the viewer (`meId`).
 */
export function ItemList({
  session,
  meId,
  onToggle,
  busyItemId,
}: {
  session: TableSession;
  meId: string | null;
  onToggle?: (itemId: string, claim: boolean) => void;
  busyItemId?: string | null;
}) {
  if (session.items.length === 0) return <p className="card text-sm text-stone-500">No items yet. The host is adding them.</p>;

  return (
    <ul className="space-y-2">
      {session.items.map((item) => {
        const mine = item.claimants.some((c) => c.id === meId);
        const content = (
          <>
            <div className="min-w-0 flex-1 text-left">
              <p className="truncate font-medium">
                {item.quantity > 1 && <span className="text-stone-500">{item.quantity}× </span>}
                {item.description}
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                {item.claimants.length === 0 ? (
                  <span className="text-xs text-stone-500">Nobody yet: shared by everyone</span>
                ) : (
                  item.claimants.map((c) => (
                    <span
                      key={c.id}
                      title={c.displayName}
                      className={`inline-flex size-6 items-center justify-center rounded-full text-[10px] font-bold ${
                        c.id === meId ? "bg-brand-600 text-white" : "bg-stone-200 text-stone-700 dark:bg-stone-700 dark:text-stone-200"
                      }`}
                    >
                      {initials(c.displayName)}
                    </span>
                  ))
                )}
              </div>
            </div>
            <span className="shrink-0 tabular-nums">{formatMoney(item.lineTotalMinor, session.currency)}</span>
          </>
        );

        return (
          <li key={item.id}>
            {onToggle ? (
              <button
                type="button"
                aria-pressed={mine}
                disabled={busyItemId === item.id}
                onClick={() => onToggle(item.id, !mine)}
                className={`card flex w-full items-center gap-3 py-3 transition active:scale-[0.99] disabled:opacity-60 ${
                  mine ? "border-brand-500 bg-brand-50 dark:bg-stone-800" : ""
                }`}
              >
                {content}
              </button>
            ) : (
              <div className="card flex items-center gap-3 py-3">{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Per-person totals from the server's preview (the same rule the confirmed expense uses). */
export function PreviewTotals({ session, meId }: { session: TableSession; meId: string | null }) {
  if (session.preview.length === 0) return null;
  return (
    <ul className="card divide-y divide-stone-100 p-0 dark:divide-stone-800">
      {session.preview.map((p) => (
        <li key={p.id} className="flex justify-between px-4 py-2 text-sm">
          <span>
            {p.id === meId ? "You" : p.displayName}
            {p.kind === "guest" && <span className="ml-1 text-xs text-stone-500">(guest)</span>}
          </span>
          <span className="tabular-nums">{formatMoney(p.amountMinor, session.currency)}</span>
        </li>
      ))}
    </ul>
  );
}
