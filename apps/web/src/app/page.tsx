import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth/config";
import { safeNext } from "@kitty/core";

export default async function Home({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const target = safeNext((await searchParams).next);
  const session = await auth();
  if (session && !session.error) redirect(target);

  return (
    <section className="flex flex-col items-center gap-6 py-16 text-center">
      <h1 className="text-4xl font-bold tracking-tight">Split costs, not friendships.</h1>
      <p className="max-w-sm text-stone-600 dark:text-stone-400">
        Unlimited expenses, no ads, free forever. Track who owes what in your flat, your friend group or your next trip.
      </p>
      <form
        action={async () => {
          "use server";
          await signIn("keycloak", { redirectTo: target });
        }}
      >
        <button className="btn-primary px-8 text-base">Sign in or create an account</button>
      </form>
    </section>
  );
}
