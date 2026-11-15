import { supportedCurrencies } from "@kitty/money";
import { ErrorBanner } from "@/components/ErrorBanner";
import { createGroup } from "../actions";

export default async function NewGroupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">New group</h1>
      <ErrorBanner code={error} />
      <form action={createGroup} className="card space-y-4">
        <input type="hidden" name="groupId" value={crypto.randomUUID()} />
        <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
        <div>
          <label htmlFor="name" className="label">Name</label>
          <input id="name" name="name" required maxLength={60} placeholder="Flat 4B, Cape Town trip…" className="field" />
        </div>
        <div>
          <label htmlFor="baseCurrency" className="label">Main currency</label>
          <select id="baseCurrency" name="baseCurrency" defaultValue="ZAR" className="field">
            {supportedCurrencies.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <button className="btn-primary w-full">Create group</button>
      </form>
    </section>
  );
}
