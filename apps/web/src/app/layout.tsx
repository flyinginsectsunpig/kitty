import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { auth, signOut } from "@/auth/config";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kitty — split shared costs",
  description: "Free, unlimited expense splitting for friends, roommates and trips.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#ea580c" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <header className="sticky top-0 z-10 border-b border-stone-200 bg-stone-50/90 backdrop-blur dark:border-stone-800 dark:bg-stone-950/90">
          <div className="mx-auto flex max-w-xl items-center justify-between px-4 py-3">
            <Link href={session ? "/groups" : "/"} className="text-lg font-bold tracking-tight text-brand-600">
              kitty
            </Link>
            {session && (
              <form
                action={async () => {
                  "use server";
                  await signOut({ redirectTo: "/" });
                }}
              >
                <button className="text-sm text-stone-500 hover:text-stone-900 dark:hover:text-stone-100">Sign out</button>
              </form>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
