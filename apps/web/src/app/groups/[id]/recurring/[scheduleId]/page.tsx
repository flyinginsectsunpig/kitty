import { recurringForm } from "@kitty/core";
import { ErrorBanner } from "@/components/ErrorBanner";
import { ExpenseForm } from "@/components/ExpenseForm";
import { loadGroup } from "@/lib/group-context";
import { unwrap } from "@/lib/ledger";
import { changeRecurring, fetchRate, saveRecurring } from "../../actions";

export default async function RecurringPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; scheduleId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id, scheduleId } = await params;
  const { error } = await searchParams;
  const { ledger, group, me } = await loadGroup(id);
  const schedule = unwrap(await ledger.GET("/groups/{groupId}/recurring/{scheduleId}", { params: { path: { groupId: id, scheduleId } } }));
  const { form, frequency, endsOn } = recurringForm(schedule, group.members.map((m) => m.id), me.id);

  const op = (name: "pause" | "resume" | "delete", label: string, className: string) => (
    <form action={changeRecurring}>
      <input type="hidden" name="groupId" value={id} />
      <input type="hidden" name="scheduleId" value={scheduleId} />
      <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
      <input type="hidden" name="op" value={name} />
      <button className={className}>{label}</button>
    </form>
  );

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">Repeating expense</h1>
      <p className="text-sm text-stone-500">
        {schedule.paused ? "Paused: nothing is added until you resume it." : "Changes apply to the next ones; expenses already added stay as they are."}
      </p>
      <ErrorBanner code={error} />
      <ExpenseForm
        groupId={id}
        members={group.members.map((m) => ({ id: m.id, displayName: m.id === me.id ? "You" : m.displayName }))}
        idempotencyKey={crypto.randomUUID()}
        action={saveRecurring}
        submitLabel="Save changes"
        groupCurrency={group.baseCurrency}
        fetchRate={fetchRate}
        initial={form}
        repeat={{ initial: frequency, endsOn, dateLocked: schedule.lastAddedOn !== null, required: true }}
      />
      <div className="grid grid-cols-2 gap-2">
        {schedule.paused ? op("resume", "Resume", "btn-secondary w-full") : op("pause", "Pause", "btn-secondary w-full")}
        {op("delete", "Stop repeating", "btn-secondary w-full text-owes")}
      </div>
    </section>
  );
}
