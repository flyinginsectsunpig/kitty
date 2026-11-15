import Link from "next/link";

const TABS = [
  { href: "", label: "Overview" },
  { href: "/settle", label: "Settle up" },
  { href: "/members", label: "People" },
  { href: "/activity", label: "Activity" },
] as const;

export function GroupNav({ groupId, groupName, active }: { groupId: string; groupName: string; active: string }) {
  return (
    <div className="space-y-3">
      <Link href="/groups" className="text-sm text-stone-500 hover:text-stone-900 dark:hover:text-stone-100">
        ← All groups
      </Link>
      <h1 className="text-2xl font-bold">{groupName}</h1>
      <nav className="flex gap-1 overflow-x-auto rounded-xl bg-stone-200/60 p-1 text-sm dark:bg-stone-800/60">
        {TABS.map((t) => (
          <Link
            key={t.href}
            href={`/groups/${groupId}${t.href}`}
            aria-current={active === t.href ? "page" : undefined}
            className="flex-1 whitespace-nowrap rounded-lg px-3 py-1.5 text-center font-medium text-stone-600 aria-[current=page]:bg-white aria-[current=page]:text-stone-900 aria-[current=page]:shadow-sm dark:text-stone-300 dark:aria-[current=page]:bg-stone-900 dark:aria-[current=page]:text-stone-100"
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
