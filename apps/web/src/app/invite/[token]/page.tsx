import { redirect } from "next/navigation";
import { getAccessToken } from "@/auth/token";
import { ErrorBanner } from "@/components/ErrorBanner";
import { getLedger, problemCode } from "@/lib/ledger";
import { acceptInvite } from "../../groups/actions";

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error: actionError } = await searchParams;
  if (!(await getAccessToken())) redirect(`/?next=${encodeURIComponent(`/invite/${token}`)}`);

  const ledger = await getLedger();
  const { data: invite, error } = await ledger.GET("/invites/{token}", { params: { path: { token } } });
  const code = actionError ?? (error ? problemCode(error) : undefined);

  return (
    <section className="card space-y-4 text-center">
      {invite ? (
        <>
          <p className="text-sm uppercase tracking-wide text-stone-500">You&apos;re invited to</p>
          <h1 className="text-2xl font-bold">{invite.groupName}</h1>
          {invite.placeholderName && (
            <p className="text-stone-600 dark:text-stone-400">
              You&apos;ll take over the spot named <strong>{invite.placeholderName}</strong>, with everything already
              recorded for them.
            </p>
          )}
          <ErrorBanner code={code} />
          <form action={acceptInvite}>
            <input type="hidden" name="token" value={token} />
            <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
            <button className="btn-primary w-full">Join group</button>
          </form>
        </>
      ) : (
        <ErrorBanner code={code ?? "not_found"} />
      )}
    </section>
  );
}
