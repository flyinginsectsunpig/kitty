import type { RecurringDto, RecurringWriteDto } from "@kitty/api-client";
import { formatMoney, type SplitMethod } from "@kitty/money";
import { editExpenseForm, toExpenseWriteDto, type ExpenseFormState } from "./expense-form";

export type Repeat = "none" | "weekly" | "monthly";
export type Frequency = "weekly" | "monthly";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** What a rule means for its start date: "Every Friday", "Every month on the 1st" (the rule comes from the date). */
export function describeRule(frequency: Frequency, startsOn: string): string {
  const { y, m, d } = parts(startsOn);
  if (frequency === "weekly") return `Every ${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}`;
  return `Every month on the ${ordinal(d)}${d >= 29 ? " (the last day in shorter months)" : ""}`;
}

/** The expense form plus how it repeats, as the ledger's schedule write. The form's date is the first period. */
export function toRecurringWriteDto(form: ExpenseFormState, frequency: Frequency, endsOn: string): RecurringWriteDto | { error: string } {
  const expense = toExpenseWriteDto(form);
  if ("error" in expense) return expense;
  const end = endsOn.trim();
  if (end !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(end)) return { error: "Enter the end date as YYYY-MM-DD." };
  if (end !== "" && end < form.occurredOn) return { error: "The end date can't be before the start date." };
  return {
    id: expense.id,
    description: expense.description,
    category: expense.category,
    currency: expense.currency,
    amountMinor: expense.amountMinor,
    payers: expense.payers,
    split: expense.split,
    frequency,
    startsOn: form.occurredOn,
    endsOn: end === "" ? null : end,
    version: form.version,
  };
}

/** A schedule as the expense form shows it for editing, with its rule. */
export function recurringForm(dto: RecurringDto, memberIds: readonly string[], meId: string): { form: ExpenseFormState; frequency: Frequency; endsOn: string } {
  const form = editExpenseForm(
    {
      id: dto.id,
      version: dto.version,
      description: dto.description,
      category: dto.category,
      currency: dto.currency,
      amountMinor: dto.amountMinor,
      occurredOn: dto.startsOn,
      payers: dto.payers,
      split: { method: dto.split.method as SplitMethod, participants: dto.split.participants },
    },
    memberIds,
    meId,
  );
  return { form, frequency: dto.frequency as Frequency, endsOn: dto.endsOn ?? "" };
}

/** One line for a schedule list: "R 12 000,00 · Every month on the 1st · next 1 Dec 2026", or "· paused" / "· ended". */
export function describeSchedule(dto: RecurringDto): string {
  const head = `${formatMoney(dto.amountMinor, dto.currency)} · ${describeRule(dto.frequency as Frequency, dto.startsOn)}`;
  if (dto.paused) return `${head} · paused`;
  if (!dto.nextDueOn) return `${head} · ended`;
  const { y, m, d } = parts(dto.nextDueOn);
  return `${head} · next ${d} ${MONTHS[m - 1]} ${y}`;
}
