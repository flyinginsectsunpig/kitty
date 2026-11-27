import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { errorMessage } from "@kitty/core";
import { getAccessToken } from "@/auth/token";
import { ErrorBanner } from "@/components/ErrorBanner";
import { PlainEntry } from "@/components/PlainEntry";
import { getDraft } from "@/lib/ai";

/** Draft ids are random URL-safe text (see the ai service's drafts.py). */
const DRAFT_ID = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * The link an AI assistant (ChatGPT, Claude: MCP) gives with a draft it prepared. Kitty shows its usual card, filled
 * in; nothing is saved or sent until the person taps Save or Send here. Only the person it was made for can open it.
 */
export default async function DraftLinkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!DRAFT_ID.test(id)) notFound();
  if (!(await getAccessToken())) redirect(`/?next=${encodeURIComponent(`/d/${id}`)}`);

  const result = await getDraft(id);
  if (!result.draft) {
    return (
      <section className="card space-y-4 text-center">
        <h1 className="text-xl font-bold">
          {result.error === "draft_gone" ? errorMessage("draft_gone") : "Couldn't open this draft"}
        </h1>
        {result.error !== "draft_gone" && <ErrorBanner code={result.error} />}
        <Link href="/groups" className="btn-secondary inline-block">
          Your groups
        </Link>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">Check and save</h1>
      <p className="text-sm text-stone-600 dark:text-stone-400">
        Your AI assistant prepared this. Nothing is saved until you tap Save.
      </p>
      <PlainEntry groupId={result.draft.groupId ?? undefined} initial={{ draft: result.draft, draftId: id }} />
    </section>
  );
}
