import { newExpenseForm } from "@kitty/core";
import { ErrorBanner } from "@/components/ErrorBanner";
import { ExpenseForm } from "@/components/ExpenseForm";
import { loadGroup } from "@/lib/group-context";
import { saveExpense } from "../../actions";

export default async function NewExpensePage({
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
      <h1 className="text-2xl font-bold">Add an expense</h1>
      <p className="text-sm text-stone-500">{group.name}</p>
      <ErrorBanner code={error} />
      <ExpenseForm
        groupId={id}
        members={group.members.map((m) => ({ id: m.id, displayName: m.id === me.id ? "You" : m.displayName }))}
        idempotencyKey={crypto.randomUUID()}
        action={saveExpense}
        submitLabel="Save expense"
        initial={newExpenseForm({
          id: crypto.randomUUID(),
          today: new Date().toISOString().slice(0, 10),
          currency: group.baseCurrency,
          meId: me.id,
          memberIds: group.members.map((m) => m.id),
        })}
      />
    </section>
  );
}
