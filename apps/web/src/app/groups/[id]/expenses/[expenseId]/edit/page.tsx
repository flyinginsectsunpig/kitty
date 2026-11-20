import { exponent, toDecimalString } from "@kitty/money";
import { ErrorBanner } from "@/components/ErrorBanner";
import { ExpenseForm } from "@/components/ExpenseForm";
import { loadGroup } from "@/lib/group-context";
import { unwrap } from "@/lib/ledger";
import { deleteExpense, saveExpense } from "../../../actions";

export default async function EditExpensePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; expenseId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id, expenseId } = await params;
  const { error } = await searchParams;
  const { ledger, group, me } = await loadGroup(id);
  const expense = unwrap(
    await ledger.GET("/groups/{groupId}/expenses/{expenseId}", { params: { path: { groupId: id, expenseId } } }),
  );

  const deleteForm = (
    <form action={deleteExpense}>
      <input type="hidden" name="groupId" value={id} />
      <input type="hidden" name="expenseId" value={expense.id} />
      <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
      <button className="btn-secondary w-full text-owes">Delete expense</button>
    </form>
  );

  if (expense.split.method === "itemized") {
    return (
      <section className="space-y-4">
        <h1 className="text-2xl font-bold">{expense.description}</h1>
        <ErrorBanner code={error} />
        <p className="card text-sm text-stone-600 dark:text-stone-400">
          This bill was split item by item at the table, so it can&apos;t be edited here. To change it, delete it and split
          the bill again.
        </p>
        {deleteForm}
      </section>
    );
  }

  const method = expense.split.method;
  const exp = exponent(expense.currency);
  const valueText = (memberId: string): string => {
    const p = expense.split.participants.find((x) => x.memberId === memberId);
    if (!p || p.value === null || p.value === undefined) return "";
    if (expense.split.method === "exact") return toDecimalString(p.value, exp);
    if (expense.split.method === "percent") return toDecimalString(p.value, 2);
    return String(p.value);
  };

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">Edit expense</h1>
      <ErrorBanner code={error} />
      <ExpenseForm
        groupId={id}
        members={group.members.map((m) => ({ id: m.id, displayName: m.id === me.id ? "You" : m.displayName }))}
        idempotencyKey={crypto.randomUUID()}
        action={saveExpense}
        submitLabel="Save changes"
        initial={{
          id: expense.id,
          version: expense.version,
          description: expense.description,
          category: expense.category,
          currency: expense.currency,
          amount: toDecimalString(expense.amountMinor, exp),
          occurredOn: expense.occurredOn,
          payerId: expense.payers[0]?.memberId ?? me.id,
          method,
          participants: group.members.map((m) => ({
            memberId: m.id,
            included: expense.split.participants.some((p) => p.memberId === m.id),
            value: valueText(m.id),
          })),
        }}
      />
      {deleteForm}
    </section>
  );
}
