import { NOTIFICATION_ROWS } from "@kitty/core";
import Link from "next/link";
import { ErrorBanner } from "@/components/ErrorBanner";
import { getLedger, unwrap } from "@/lib/ledger";
import { saveNotifications } from "./actions";

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { error, saved } = await searchParams;
  const ledger = await getLedger();
  const settings = unwrap(await ledger.GET("/me/notifications"));

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Notifications</h1>
        <Link href="/groups" className="text-sm text-brand-600 hover:underline">Back to groups</Link>
      </div>
      <ErrorBanner code={error} />
      {saved && <p role="status" className="text-sm text-owed">Saved.</p>}
      <form action={saveNotifications} className="card space-y-4">
        <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
        <table className="w-full text-left">
          <thead className="text-sm text-stone-500">
            <tr>
              <th className="pb-2 font-normal">Tell me when</th>
              <th className="pb-2 text-center font-normal">
                Push<span className="block text-xs">on the Android app</span>
              </th>
              <th className="pb-2 text-center font-normal">Email</th>
            </tr>
          </thead>
          <tbody>
            {NOTIFICATION_ROWS.map((row) => (
              <tr key={row.kind} className="border-t border-stone-200 dark:border-stone-700">
                <td className="py-3">{row.label}</td>
                <td className="py-3 text-center">
                  <input
                    type="checkbox"
                    name={row.push}
                    defaultChecked={settings[row.push]}
                    aria-label={`${row.label}: push`}
                    className="size-5"
                  />
                </td>
                <td className="py-3 text-center">
                  <input
                    type="checkbox"
                    name={row.email}
                    defaultChecked={settings[row.email]}
                    disabled={!settings.emailAvailable}
                    aria-label={`${row.label}: email`}
                    className="size-5"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!settings.emailAvailable && (
          <p className="text-sm text-stone-500">Verify your email address to get email.</p>
        )}
        <button className="btn-primary w-full">Save</button>
      </form>
    </section>
  );
}
