import { supportedCurrencies } from "@kitty/money";
import { ErrorBanner } from "@/components/ErrorBanner";
import { loadGroup } from "@/lib/group-context";
import { createTableSession } from "../actions";

export default async function NewTablePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const { group, me } = await loadGroup(id);

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">Split a bill at the table</h1>
      <p className="text-sm text-stone-600 dark:text-stone-400">
        Enter what&apos;s on the bill, show everyone a QR code, and each person taps what they had. Shared plates and the tip are
        split fairly for you.
      </p>
      <ErrorBanner code={error} />
      <form action={createTableSession} className="card space-y-4">
        <input type="hidden" name="groupId" value={id} />
        <input type="hidden" name="sessionId" value={crypto.randomUUID()} />
        <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
        <div>
          <label htmlFor="title" className="label">Where are you?</label>
          <input id="title" name="title" required maxLength={80} placeholder="Friday dinner at Mzansi" className="field" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="payerMemberId" className="label">Who&apos;s paying the bill?</label>
            <select id="payerMemberId" name="payerMemberId" defaultValue={me.id} className="field">
              {group.members.map((m) => (
                <option key={m.id} value={m.id}>{m.id === me.id ? "You" : m.displayName}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="currency" className="label">Currency</label>
            <select id="currency" name="currency" defaultValue={group.baseCurrency} className="field">
              {supportedCurrencies.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <button className="btn-primary w-full text-base">Start</button>
      </form>
    </section>
  );
}
