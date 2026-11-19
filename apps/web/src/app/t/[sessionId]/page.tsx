import Link from "next/link";
import { notFound } from "next/navigation";
import { ErrorBanner } from "@/components/ErrorBanner";
import { ClaimTable } from "@/components/table/ClaimTable";
import { isUuid } from "@/lib/ids";
import { hubUrl, loadTable } from "@/lib/table";
import { joinTable } from "./actions";

/** The QR link. Members of the group claim as themselves; anyone else can join as a guest with just a name. */
export default async function TablePage({
  params,
  searchParams,
}: {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<{ g?: string; error?: string }>;
}) {
  const { sessionId } = await params;
  const { g, error } = await searchParams;
  if (!isUuid(sessionId)) notFound();
  const groupId = isUuid(g) ? g : null;

  const table = await loadTable(sessionId, groupId);
  if (table.status === "ok") {
    // Guests skip the member attempt on later refreshes; members keep the group id so they stay themselves.
    return <ClaimTable initial={table.session} groupId={table.access === "member" ? groupId : null} hubUrl={hubUrl()} />;
  }

  if (table.status === "closed") {
    return (
      <section className="card space-y-2 py-6 text-center">
        <h1 className="text-xl font-bold">This bill is closed</h1>
        <p className="text-sm text-stone-600 dark:text-stone-400">
          The host has finished with it. If you still owe something, they&apos;ll let you know.
        </p>
      </section>
    );
  }

  const next = `/t/${sessionId}${groupId ? `?g=${groupId}` : ""}`;
  return (
    <section className="space-y-4 py-6">
      <h1 className="text-2xl font-bold">Join the table</h1>
      <p className="text-stone-600 dark:text-stone-400">Tap what you had and see your share. No account needed.</p>
      <ErrorBanner code={error} />
      <form action={joinTable} className="card space-y-3">
        <input type="hidden" name="sessionId" value={sessionId} />
        <input type="hidden" name="groupId" value={groupId ?? ""} />
        <label htmlFor="displayName" className="label">Your name</label>
        <input id="displayName" name="displayName" required maxLength={40} autoComplete="given-name" className="field" />
        <button className="btn-primary w-full text-base">Join as a guest</button>
      </form>
      <p className="text-center text-sm text-stone-500">
        In this group already?{" "}
        <Link href={`/?next=${encodeURIComponent(next)}`} className="font-medium text-brand-600 underline">Sign in</Link>
      </p>
    </section>
  );
}
