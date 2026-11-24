# Kitty Phase 3b: Recurring expenses (pulse schedules), Design

Status: draft for owner approval. Builds on the [overall design](2026-11-15-kitty-design.md) §5.1 "pulse" and §6 feature 8,
and on [3a](2026-11-24-kitty-phase3a-fx-design.md) (pulse exists; exchange rates).

## 1. Intent

Flatmates split rent on the 1st, a group shares a streaming subscription. Today someone has to add that expense every
month. 3b lets a group member set it up once; after that it lands on balances by itself when it's due.

It is also pulse's second real job: pulse owns the schedule timing (due dates, catch-up, pause), fed by ledger events over
Kafka, and asks the ledger to add each period over gRPC with its own service identity. That shows a Go Kafka consumer
(which 3c's notifications reuse) and service-to-service auth.

## 2. Goals, non-goals, anti-goals

**Goals (owner decisions in bold)**
- **A due expense goes straight onto balances** (no draft to confirm). It is an ordinary expense afterwards: editable and
  deletable, and the activity feed says it was added automatically.
- Any group member creates, edits, pauses, resumes and deletes a schedule, on web and mobile.
- Schedules repeat **weekly** (on a weekday) or **monthly** (on a day of the month; 29–31 means the last day in shorter
  months), from a start date to an optional end date.
- **The rule comes from the start date** (builder's call): "monthly" repeats on the start date's day of the month,
  "weekly" on its weekday. The form keeps its one date field: that date is the first period. No separate day picker.
- **At most one expense per cycle, even across edits** (builder's call): a cycle is a calendar month (monthly) or a
  Monday–Sunday week (weekly). Changing a running schedule's rule takes effect from the next cycle after the last period
  added, so moving rent from the 1st to the 2nd on the 1st doesn't charge November twice, and switching monthly to weekly
  on 24 Nov starts the weekly periods in December.
- The expense template is the normal expense form: description, category, amount, currency, payer, split (equal, exact,
  percent, shares). Foreign currency gets that day's ECB rate (3a's rules).
- After downtime, missed periods are added, each dated its due date, **at most the 12 most recent** per schedule.
- A period is never added twice, whatever retries, restarts or replays happen.

**Non-goals**
- Yearly, every-N-weeks, or "last Friday of the month" rules. Itemized (table) splits as templates.
- Reminders before something is added, and "added for you" notifications (3c).
- Backfilling periods before a schedule was created (the start date can't be in the past; see §3.2).

**Anti-goals**
- A period added twice, or added while the schedule is paused, deleted or past its end.
- The ledger trusting pulse blindly: the ledger checks every request is pulse's and that the period is a real, current
  occurrence of a live schedule.
- pulse reachable from outside the server, or pulse's gRPC calls into the ledger reachable from outside.
- Recurrence rules that disagree between the app's "next due" and when pulse actually adds it.

## 3. How it works

### 3.1 Data flow
```
web/mobile ──REST──▶ ledger: recurring_schedules (template + rule)   ──outbox──▶ Kafka topic ledger.recurring
                                                                                    (compacted, key = schedule id)
pulse: consumes ledger.recurring → pulse.schedules (rule + state) → every minute: due periods
pulse ──gRPC AddOccurrence(schedule_id, period) + service token──▶ ledger: creates the expense (same code path)
```

### 3.2 ledger
- **Table `RecurringSchedules`**: id, group id, created-by user, the expense template (same fields and validation as an
  expense write, including split inputs), `Frequency` (`weekly` | `monthly`), `Weekday` or `DayOfMonth`, `StartsOn`,
  `EndsOn?`, `Paused`, `NotBefore` (the first date periods may be added from: the start date, then the resume date
  after a pause), `Version`, soft delete.
- **REST** under `/groups/{groupId}/recurring` (group members only, Idempotency-Key as every write): list (with each
  schedule's next due date), get, create, update (template and rule; optimistic version), pause, resume, delete.
  - `StartsOn` must be today or later (group's view of "today" is UTC; see §6). Once a schedule has added a period its
    start date can't change (the form shows it read-only); the frequency can, with the next rule.
  - Resume sets `NotBefore` to today, so paused periods are never added later.
  - A rule change (frequency, or a not-yet-started start date) sets `NotBefore` to the later of today and the first day
    of the cycle after `LastAddedPeriod` (the ledger records it on every `AddOccurrence`). Template-only edits (amount,
    split, payer, description) don't touch `NotBefore`.
  - Every change writes the schedule's **full timing state** to the outbox → topic `ledger.recurring`, key = schedule
    id: `RecurringScheduleChanged{event_id, schedule_id, group_id, frequency, weekday, day_of_month, starts_on, ends_on,
    not_before, paused, deleted, version}`. The topic is **log-compacted**, so pulse can rebuild every schedule from it.
- **gRPC** `kitty.ledger.v1.RecurringService/AddOccurrence(schedule_id, period) → {expense_id, already_added}`:
  - Served on a separate plain-HTTP/2 port (`Ledger:GrpcPort`, default 8082 in containers) that Caddy doesn't route.
  - Requires a Keycloak access token for client `kitty-pulse` (audience `kitty-ledger`, `azp` = `kitty-pulse`).
    Any other caller: `PERMISSION_DENIED`.
  - Checks the schedule exists, isn't deleted or paused, and `period` is an occurrence of its rule within
    [`NotBefore`, `EndsOn`]; otherwise `FAILED_PRECONDITION` (permanent: pulse drops that period). A `period` after the
    ledger's today (clocks a few seconds apart at midnight) is `UNAVAILABLE` with "not due yet": pulse retries.
  - A foreign period whose converted amount would exceed the ledger's maximum is saved without a rate (counted in the
    converted total's `excludedCount`), never rejected: a recurring period must not vanish silently.
  - Creates the expense through the same validation and write path as `POST /expenses` (audit as the schedule's creator
    with an "added automatically" marker, outbox `ExpenseChanged`), dated `period`, with `RecurringScheduleId` and
    `RecurringPeriod` set. A unique index on (`RecurringScheduleId`, `RecurringPeriod`), **including soft-deleted
    expenses**, makes a repeat return the existing expense with `already_added = true`: an automatically added expense
    someone deleted is not added again.
  - The REST API refuses pulse's token (it has no user), and the gRPC endpoint refuses users' tokens.
- **Recurrence math** (`Domain/Recurring/Recurrence.cs`: occurrences of a rule in a date range, next occurrence on or
  after a date) is mirrored in Go and pinned by `contracts/fixtures/recurrence.json`, which both test suites run.

### 3.3 pulse
- **Consumer** of `ledger.recurring` (group `pulse-recurring`), decoding the schema-registry wire format into the
  generated Go type. Upserts `pulse.schedules` (newer `version` wins; `deleted` removes it). Commits offsets after the
  upsert, so a crash re-reads (upserts are idempotent).
- **Scheduler**, every minute: for each live schedule, the occurrences in [`not_before`, min(`ends_on`, today)] that are
  later than its `last_added` period, the latest 12 only; for each, oldest first, call `AddOccurrence`. On success (or
  `already_added`, or `FAILED_PRECONDITION`) record `last_added`; on `UNAVAILABLE` (ledger down, or "not due yet") stop
  that schedule for this tick and retry next minute.
- **Service token** via OAuth2 client credentials (`kitty-pulse`, secret from `PULSE_CLIENT_SECRET`), cached until shortly
  before it expires.
- New env: `PULSE_KAFKA_BOOTSTRAP`, `PULSE_SCHEMA_REGISTRY_URL`, `PULSE_LEDGER_GRPC`, `PULSE_TOKEN_URL`,
  `PULSE_CLIENT_SECRET`. All required (fail fast).

### 3.4 Web and mobile
- **Expense form (new expense only):** a "Repeat" control: Doesn't repeat / Weekly / Monthly, with a line saying what
  that means for the chosen date ("Every month on the 1st", "Every Friday"), and an optional end date. Saving a
  repeating one creates the schedule (not an expense): pulse adds each period when it's due — today's within a minute.
- **Group screen:** a "Repeating" section listing each schedule ("Rent · R12 000,00 · monthly on the 1st · next 1 Dec",
  "paused") with edit, pause/resume and delete. Editing opens the expense form prefilled with the template and rule.
- **Activity:** "Fx Tester's schedule added Rent (R12 000,00)" for automatically added expenses (core's `describeActivity`).

### 3.5 Running it
- **Keycloak realm:** new confidential client `kitty-pulse` (service account only, audience mapper `kitty-ledger`,
  secret `${PULSE_CLIENT_SECRET:dev-only-kitty-pulse-secret}`). Existing servers add it once (RUNBOOK, like 2c's client).
- **Aspire:** pulse gets Kafka, schema registry, the ledger's gRPC endpoint and Keycloak's token URL; the ledger gets a
  second (HTTP/2) endpoint. The ledger still waits for pulse (rates); pulse doesn't wait for the ledger (it retries its
  calls), so there's no start-up cycle. **Compose:** the same, internal only; `PULSE_CLIENT_SECRET` in `.env`.
- **CI:** existing workflows; pulse's consumer test uses Redpanda via Testcontainers (as the ledger's tests do).

## 4. Approaches considered
1. **pulse owns the schedule timing (chosen by the owner).** Real work for pulse; builds 3c's consumer; costs a second
   copy of the recurrence math (pinned by a shared fixture) and a service identity.
2. Ledger only: a .NET background timer. Simplest, but pulse does nothing in 3b and the overall design gives it this job.
3. pulse as a timer that asks the ledger "anything due?". Little code, but pulse becomes plumbing (an anti-goal).

## 5. New dependencies (owner approval needed)
- Go: `github.com/twmb/franz-go` (Kafka client, plus its `pkg/sr` schema-registry helpers), `golang.org/x/oauth2`
  (client credentials), Testcontainers' Redpanda module (tests).
- .NET: `Grpc.AspNetCore` (the ledger serves gRPC).

## 6. Decisions and calls (builder's unless marked)
- "Today" for due dates is the UTC date, as for 3a's settlement rates. A 1st-of-the-month rent appears at 02:00 SAST.
- The scheduler tick is one minute; `last_added` lives in `pulse.schedules`.
- The automatically added expense's creator is the schedule's creator (the person who set it up).
- Left to the builder: table and column names, exact UI copy and layout within the existing screens' style.
