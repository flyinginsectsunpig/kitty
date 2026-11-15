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
        initial={{
          id: crypto.randomUUID(),
          version: null,
          description: "",
          category: "other",
          currency: group.baseCurrency,
          amount: "",
          occurredOn: new Date().toISOString().slice(0, 10),
          payerId: me.id,
          method: "equal",
          participants: group.members.map((m) => ({ memberId: m.id, included: true, value: "" })),
        }}
      />
    </section>
  );
}
