# Kitty Phase 3b — Recurring Expenses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group members set up weekly or monthly expenses once. pulse adds each period straight onto balances when it's
due, through the ledger, with its own service identity.

**Architecture:**
- The ledger stores schedules and serves them over REST.
- Every schedule change goes through the outbox to a compacted Kafka topic, `ledger.recurring`. pulse consumes it into
  its own `pulse.schedules` table.
- Every minute, pulse works out the due periods and calls the ledger's gRPC `AddOccurrence` with a Keycloak
  client-credentials token. The ledger validates the period and writes the expense through the normal path.
- The recurrence rule is mirrored in C# and Go, and pinned by `contracts/fixtures/recurrence.json`.

**Tech Stack:**
- Go 1.27: franz-go and its `pkg/sr`, golang.org/x/oauth2, grpc-go, pgx, testcontainers-go with the postgres and
  redpanda modules
- .NET 10: Grpc.AspNetCore
- Existing: EF Core and Postgres, Confluent.Kafka with the protobuf serializer, Next.js, Expo

**Spec:** `docs/superpowers/specs/2026-11-24-kitty-phase3b-recurring-design.md`

## Global Constraints

- New dependencies, exact pins (the owner approved the spec's §5):
  - Go: `github.com/twmb/franz-go v1.22.3`, `github.com/twmb/franz-go/pkg/sr v1.8.0`, `golang.org/x/oauth2 v0.38.0`,
    `github.com/testcontainers/testcontainers-go/modules/redpanda v0.45.0`.
  - .NET: `Grpc.AspNetCore 2.85.0`.
  - Anything else needs the owner's OK first.
- **"Today" is the UTC date everywhere:** the ledger uses `TimeProvider`; pulse uses `Service.Now`-style injection.
- **Rule from the start date:** weekly means `StartsOn`'s weekday, every 7 days. Monthly means `StartsOn`'s day of the
  month, clamped to the month's last day; the clamp never carries forward, so a schedule starting 31 Jan gives 31 Jan,
  28 Feb, 31 Mar.
- **A cycle is a calendar month (monthly) or a Monday–Sunday week (weekly):**
  - A frequency change on a started schedule sets `NotBefore = max(today, first day of the cycle after LastAddedPeriod)`,
    using the old frequency's cycle.
  - Resume sets `NotBefore = today`.
  - `StartsOn` is editable only while `LastAddedPeriod` is null, and must then be today or later.
- **Catch-up cap:** pulse adds at most the latest 12 due periods per schedule per run of missed periods.
- **gRPC error contract (`AddOccurrence`):**
  - `PERMISSION_DENIED`: not pulse's token.
  - `NOT_FOUND`: no schedule.
  - `FAILED_PRECONDITION`: deleted, paused, before `NotBefore`, after `EndsOn`, or not an occurrence. pulse drops these.
  - `UNAVAILABLE` with message `not due yet`: a period after the ledger's today. pulse retries these.
- **The service client id is exactly `kitty-pulse`:**
  - the ledger's gRPC policy requires claim `azp == "kitty-pulse"`;
  - every REST endpoint refuses that `azp` with 403 `service_token_not_allowed`.
- **New error codes** (`ErrorCodes` and core's `errorMessage`):
  - `schedule_started`: "This schedule has already added expenses, so its start date can't change."
  - `service_token_not_allowed`: no UI text needed.
- **Topic:** `ledger.recurring`, key = schedule id, `cleanup.policy=compact`, 3 partitions, created by the ledger's
  `Topics.EnsureAsync`.
- Conventional commits, one logical change each. No attribution lines.

## Review Focus

1. **A monthly schedule on the 31st or the 30th in February and April, leap and non-leap years.** It should land on the
   last day and go back to the 31st afterwards. *Test:* Task 1 fixture rows `monthly 31st through Feb 2027` and
   `monthly 31st through Feb 2028`.
2. **pulse stopped for 3 months with a weekly schedule.** On restart only the latest 12 periods are added, each dated its
   own due date. *Test:* Task 5 `TestTick_CatchUpAddsOnlyTheLatest12`.
3. **The same period requested twice** (a retry, a replay, or two pulse instances). Exactly one expense results, and the
   second call says `already_added`. *Test:* Task 3 `Adding_the_same_period_twice_returns_the_same_expense`.
4. **Paused for two periods, then resumed.** Nothing is ever added for the paused periods. *Test:* Task 2
   `Resume_sets_not_before_to_today` and Task 5 `TestTick_PeriodsBeforeNotBeforeAreNeverAdded`.
5. **pulse's clock just past midnight UTC while the ledger's isn't yet.** That period is retried, not lost. *Test:*
   Task 3 `A_period_after_today_is_not_due_yet` and Task 5 `TestTick_UnavailableIsRetriedNextTick`.

---

### Task 1: Contracts and the recurrence rule in C# and Go

**Files:**
- Create: `contracts/proto/kitty/recurring/v1/schedules.proto` (event) and `contracts/proto/kitty/ledger/v1/recurring.proto` (gRPC)
- Create: `contracts/fixtures/recurrence.json`
- Create: `services/ledger/src/Kitty.Ledger/Domain/Recurring/Recurrence.cs`. Test: `services/ledger/tests/Kitty.Ledger.UnitTests/RecurrenceFixtureTests.cs`
- Create: `services/pulse/internal/recurring/recurrence.go`. Test: `services/pulse/internal/recurring/recurrence_test.go`
- Modify:
  - `services/ledger/src/Kitty.Ledger/Kitty.Ledger.csproj`: `kitty/recurring/**` with `GrpcServices="None"`, `kitty/ledger/**` with `GrpcServices="Server"`
  - `services/pulse/buf.gen.yaml`: add both paths
  - `Directory.Packages.props` and the ledger csproj: add `Grpc.AspNetCore`

**Interfaces:**
- Produces:
  ```proto
  // schedules.proto: package kitty.recurring.v1; csharp_namespace Kitty.Contracts.Recurring.V1; go_package .../gen/kitty/recurring/v1;recurringv1
  message RecurringScheduleChanged {
    enum Frequency { FREQUENCY_UNSPECIFIED = 0; FREQUENCY_WEEKLY = 1; FREQUENCY_MONTHLY = 2; }
    string event_id = 1; google.protobuf.Timestamp occurred_at = 2;
    string schedule_id = 3; string group_id = 4; Frequency frequency = 5;
    string starts_on = 6; string ends_on = 7; string not_before = 8; // YYYY-MM-DD; ends_on "" = none
    bool paused = 9; bool deleted = 10; int32 version = 11;
  }
  // recurring.proto: package kitty.ledger.v1; csharp_namespace Kitty.Contracts.Ledger.V1; go_package .../gen/kitty/ledger/v1;ledgerv1
  service RecurringService { rpc AddOccurrence(AddOccurrenceRequest) returns (AddOccurrenceResponse); }
  message AddOccurrenceRequest { string schedule_id = 1; string period = 2; }
  message AddOccurrenceResponse { string expense_id = 1; bool already_added = 2; }
  ```
- C# (`Kitty.Ledger.Domain.Recurring`):
  - `enum Frequency { Weekly, Monthly }`
  - `record Rule(Frequency Frequency, DateOnly StartsOn)`
  - `static class Recurrence`, with:
    - `IReadOnlyList<DateOnly> Between(Rule r, DateOnly from, DateOnly to)`: inclusive, ascending
    - `bool IsOccurrence(Rule r, DateOnly d)`
    - `DateOnly NextOnOrAfter(Rule r, DateOnly d)`
    - `DateOnly NextCycleStart(Frequency f, DateOnly period)`: the 1st of the next month, or the next Monday
- Go (`internal/recurring`): `Frequency`, `Rule{Frequency; StartsOn time.Time}`, `Between`, `IsOccurrence`,
  `NextCycleStart`, with the same meanings. Go doesn't need `NextOnOrAfter`.

- [ ] **Step 1: Write the fixture.** Sections: `between` (`{name, frequency, startsOn, from, to, expected[]}`),
  `isOccurrence`, `nextOnOrAfter` and `nextCycleStart`. Rows:
  - `monthly 31st through Feb 2027`: start 2027-01-31, Jan–Apr → 01-31, 02-28, 03-31, 04-30
  - `monthly 31st through Feb 2028`: start 2028-01-31 → 01-31, 02-29, 03-31
  - `monthly 1st`: start 2026-12-01, to 2027-03-15 → 12-01, 01-01, 02-01, 03-01
  - `weekly Friday`: start 2026-11-27, through 2026-12-25 → 11-27, 12-04, 12-11, 12-18, 12-25
  - `from before start`: never before `StartsOn`
  - `empty range`: from > to → `[]`
  - `isOccurrence`: 2027-02-28 for a 31st rule → true; 2027-02-27 → false
  - `nextOnOrAfter`: start 2026-11-01 monthly, at 2026-11-02 → 2026-12-01
  - `nextCycleStart`:
    - monthly 2026-11-01 → 2026-12-01
    - weekly Wed 2026-11-25 → Mon 2026-11-30
    - weekly Mon 2026-11-30 → Mon 2026-12-07
- [ ] **Step 2: Write failing tests** in both languages that run every fixture row (same pattern as `FxFixtureTests`
  and `fx.test.ts`; the Go test reads `../../../../contracts/fixtures/recurrence.json`).
- [ ] **Step 3:** `dotnet test services/ledger/tests/Kitty.Ledger.UnitTests` and `go test ./internal/recurring/`. Expected: FAIL.
- [ ] **Step 4:** Write the protos and run `go tool -modfile=tools.go.mod buf lint ../../contracts && go tool -modfile=tools.go.mod buf generate`.
  Implement both rule modules. Add `Grpc.AspNetCore`.
- [ ] **Step 5:** Re-run both. Expected: PASS. The ledger builds with the generated server base `RecurringService.RecurringServiceBase`.
- [ ] **Step 6: Commit** `feat(recurring): schedule contracts and the recurrence rule in C# and Go`

### Task 2: Schedules in the ledger (REST, outbox to `ledger.recurring`)

**Files:**
- Create: `services/ledger/src/Kitty.Ledger/Features/Recurring/RecurringEndpoints.cs`, `RecurringDtos.cs`
- Modify:
  - `Data/Entities/Entities.cs`: `RecurringSchedule`
  - `LedgerDbContext.cs`: the template as `jsonb`, a `Frequency` string, an index on `GroupId`
  - a migration `RecurringSchedules`
  - `Infrastructure/Messaging/Outbox.cs`: `RecurringScheduleChanged(RecurringSchedule s)`
  - `Topics.cs`: `LedgerRecurring`, compacted
  - `Program.cs`: `group.MapRecurring()`
  - `Infrastructure/Auth/AuthSetup.cs`: the fallback policy refuses `azp == kitty-pulse` with 403 `service_token_not_allowed`
  - `ErrorCodes`
- Test: `services/ledger/tests/Kitty.Ledger.IntegrationTests/RecurringTests.cs`. `TestTokens.ForService(string clientId)` is a token with `azp` = clientId and `sub` = a fixed service-account id.

**Interfaces:**
- Consumes: `Recurrence`, `ExpenseValidator`.
- Produces:
  - `RecurringSchedule`:
    - Id, GroupId, CreatedByUserId
    - `TemplateJson` (an `ExpenseTemplate` record: Description, Category, Currency, AmountMinor, Payers, Split)
    - Frequency, StartsOn, EndsOn?, NotBefore, Paused
    - `LastAddedPeriod?`, Version (concurrency token), CreatedAt, UpdatedAt, DeletedAt?
  - `RecurringWriteDto(Guid Id, string Description, string Category, string Currency, long AmountMinor, IReadOnlyList<PayerDto> Payers, SplitDto Split, Frequency Frequency, DateOnly StartsOn, DateOnly? EndsOn, int? Version)`
  - `RecurringDto(Guid Id, string Description, string Category, string Currency, long AmountMinor, IReadOnlyList<PayerDto> Payers, SplitDto Split, Frequency Frequency, DateOnly StartsOn, DateOnly? EndsOn, bool Paused, DateOnly? NextDueOn, DateOnly? LastAddedOn, int Version, Guid CreatedBy)`
  - Routes under `/groups/{groupId}/recurring`. Names are `ListRecurring`, `GetRecurring`, `CreateRecurring`,
    `UpdateRecurring`, `PauseRecurring`, `ResumeRecurring` and `DeleteRecurring`.
    - `POST /` and `PUT /{id}` take a `RecurringWriteDto`.
    - `POST /{id}/pause` and `POST /{id}/resume` have no body.
    - `DELETE /{id}` soft-deletes.
  - `NextDueOn`:
    - null when paused or deleted;
    - otherwise `NextOnOrAfter(rule, max(NotBefore, today, LastAddedPeriod+1))`;
    - null if that date is after `EndsOn`.
  - Every create, update, pause, resume and delete:
    - writes an audit row (entity type `recurring`);
    - queues `RecurringScheduleChanged` with the full state and `deleted = DeletedAt != null`.
- [ ] **Step 1: Write failing tests.**
  - `Create_returns_the_schedule_with_its_next_due_date`
  - `Itemized_split_is_rejected`
  - `Start_date_in_the_past_is_rejected`
  - `Invalid_template_is_rejected_like_an_expense`: reuse a split-sum-mismatch case
  - `Changing_frequency_after_periods_were_added_starts_at_the_next_cycle`: set `LastAddedPeriod` through the DbContext
    to Nov 1 (monthly), switch to weekly on "today" = Nov 24 with an injected `TimeProvider` → `NotBefore` = 2026-12-01
  - `Start_date_is_fixed_once_a_period_was_added`: → 409 `schedule_started`
  - `Resume_sets_not_before_to_today`
  - `Every_change_queues_a_RecurringScheduleChanged_with_full_state`: read the outbox rows
  - `Non_member_gets_404`
  - `Service_token_is_refused_on_rest`: `/me` with `ForService("kitty-pulse")` → 403 `service_token_not_allowed`
- [ ] **Step 2:** `dotnet test services/ledger/tests/Kitty.Ledger.IntegrationTests -- --filter-class "*RecurringTests"`. Expected: FAIL.
- [ ] **Step 3:** Implement, then add the migration. Inject `TimeProvider` (already registered) so tests can pin the date: use the existing `FakeTimeProvider` pattern if one exists, else register a settable one in the factory.
- [ ] **Step 4:** Run the full ledger suite. Update the OpenAPI contract with `KITTY_UPDATE_OPENAPI=1`, then run again without it. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ledger): recurring schedules with a compacted change topic`

### Task 3: `AddOccurrence` over gRPC in the ledger

**Files:**
- Create: `services/ledger/src/Kitty.Ledger/Features/Recurring/RecurringGrpcService.cs`
- Modify:
  - `Features/Expenses/ExpenseEndpoints.cs`: extract the create path into `internal static Task<Expense> CreateExpenseAsync(...)`, used by `CreateAsync` and the gRPC service; `ApplyRate` gains `bool saveWithoutRateIfTooLarge`
  - `Expense`: `RecurringScheduleId?`, `RecurringPeriod?`, and a unique index on both that is unfiltered, so soft-deleted rows count
  - migration `ExpenseRecurringPeriod`
  - `Program.cs`:
    - `AddGrpc()`
    - authorization policy `pulse`: `RequireClaim("azp", "kitty-pulse")`
    - `app.MapGrpcService<RecurringGrpcService>().RequireHost($"*:{grpcPort}").RequireAuthorization("pulse")`
    - a Kestrel HTTP/2-only endpoint on `Ledger:GrpcPort` (default 8082) when that port is configured
  - core `describeActivity`: an expense snapshot with `recurringScheduleId` reads `expense "Rent" (R 12 000,00), added automatically`
- Test: `services/ledger/tests/Kitty.Ledger.IntegrationTests/RecurringGrpcTests.cs`. It uses `GrpcChannel.ForAddress("http://localhost:8082", new() { HttpHandler = factory.Server.CreateHandler() })` with a `ForService("kitty-pulse")` bearer.

**Interfaces:**
- Consumes: `RecurringSchedule`, `Recurrence.IsOccurrence`, `ExpenseRates`, the error contract in Global Constraints.
- Produces:
  - `RecurringGrpcService.AddOccurrence`:
    - sets `LastAddedPeriod = max(existing, period)` in the same transaction;
    - the expense's `CreatedByUserId` is the schedule creator;
    - the audit row is `created` as that user, with the snapshot including `recurringScheduleId`;
    - outbox `ExpenseChanged`.
- [ ] **Step 1: Write failing tests.**
  - `Adds_the_period_as_an_expense_dated_that_day`
  - `Adding_the_same_period_twice_returns_the_same_expense` (`already_added = true`, one row)
  - `A_deleted_added_expense_is_not_added_again`
  - `A_user_token_is_permission_denied`
  - `Paused_deleted_ended_or_off_rule_is_failed_precondition`: a theory
  - `A_period_after_today_is_not_due_yet` (`UNAVAILABLE`)
  - `Foreign_period_gets_that_days_rate`
  - `Too_large_to_convert_is_saved_without_rate`
  - `Records_last_added_period`
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement, add the migration, and update core's `describeActivity` with its test (`packages/core/test/activity.test.ts`).
- [ ] **Step 4:** Run the full ledger suite plus the OpenAPI contract, and `pnpm --filter @kitty/core test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ledger): pulse adds recurring periods over gRPC`

### Task 4: pulse consumes `ledger.recurring` into `pulse.schedules`

**Files:**
- Create: `services/pulse/internal/recurring/store.go`, `services/pulse/internal/recurring/consumer.go`, `services/pulse/internal/recurring/wire.go`
- Test: `wire_test.go`, `store_test.go` (Testcontainers Postgres, the same `TestMain` pattern as `fx`), and `consumer_test.go` (Testcontainers Redpanda)

**Interfaces:**
- Consumes: `recurringv1.RecurringScheduleChanged`.
- Produces:
  - `func StripConfluentHeader(b []byte) ([]byte, error)`:
    - requires magic byte 0 and a 4-byte schema id;
    - then the message-index list: a single 0x00 means `[0]`; otherwise a varint count and varint indexes (zigzag as Confluent writes them);
    - returns the protobuf payload.
  - `type Schedule struct { ID, GroupID string; Rule Rule; EndsOn *time.Time; NotBefore time.Time; Paused, Deleted bool; Version int32; LastAdded *time.Time }`
  - `OpenStore(ctx, url)`: creates `pulse.schedules` the 3a way, checking `pg_namespace` first.
  - `(*Store) Upsert(ctx, Schedule) error`: only when `version` is newer; never touches `last_added`.
  - `(*Store) Live(ctx) ([]Schedule, error)`: not deleted and not paused.
  - `(*Store) SetLastAdded(ctx, id string, period time.Time) error`
  - `func Consume(ctx context.Context, client *kgo.Client, store *Store) error`:
    - group `pulse-recurring`, auto-commit off;
    - per record: strip, unmarshal, upsert, then commit;
    - a malformed record is logged and committed (skipped).
- [ ] **Step 1: Write failing tests.**
  - `TestStripConfluentHeader_SingleZeroIndex`
  - `TestStripConfluentHeader_ExplicitIndexes`
  - `TestStripConfluentHeader_BadMagic`
  - `TestStore_OlderVersionIsIgnored`
  - `TestStore_DeletedIsNotLive`
  - `TestStore_UpsertKeepsLastAdded`
  - `TestConsume_UpsertsFromTopic`: produce a framed record with a franz-go client to Redpanda; poll until `Live` returns it
- [ ] **Step 2:** `go test ./internal/recurring/`. Expected: FAIL.
- [ ] **Step 3:** Implement and add the franz-go dependencies.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pulse): keep a copy of recurring schedules from the ledger's topic`

### Task 5: pulse's scheduler, service token and wiring

**Files:**
- Create: `services/pulse/internal/recurring/scheduler.go`, `services/pulse/internal/recurring/ledgerclient.go`
- Modify: `services/pulse/cmd/pulse/main.go`
- Test: `scheduler_test.go` (fake `Adder` and fake clock; the store is a small in-memory fake behind an interface) and `ledgerclient_test.go` (bufconn server checking the bearer token)

**Interfaces:**
- Produces:
  - `type Adder interface { AddOccurrence(ctx context.Context, scheduleID string, period time.Time) error }`
  - `type Schedules interface { Live(ctx) ([]Schedule, error); SetLastAdded(ctx, id string, period time.Time) error }`
  - `type Scheduler struct { Store Schedules; Ledger Adder; Now func() time.Time }`, and `func (s *Scheduler) Tick(ctx) error`:
    - due = `Between(rule, max(NotBefore, LastAdded+1d), min(EndsOn, today))`, the last 12 only, oldest first;
    - `nil`, `already_added` or `FailedPrecondition` → `SetLastAdded`;
    - `Unavailable` or other errors → stop this schedule for this tick.
  - `NewLedgerClient(addr, tokenURL, secret string) (Adder, error)`:
    - gRPC over h2c;
    - per-RPC credentials from `clientcredentials.Config{ClientID: "kitty-pulse"}`;
    - a custom `PerRPCCredentials` whose `RequireTransportSecurity()` returns false, because the network is internal;
    - `already_added` is treated as success.
  - `main`:
    - new env vars (spec §3.3), required;
    - runs `Consume` and a one-minute `Tick` loop beside the rates server;
    - Kafka is reached with franz-go `kgo.SeedBrokers(PULSE_KAFKA_BOOTSTRAP)`.
- [ ] **Step 1: Write failing tests.**
  - `TestTick_AddsTodaysPeriod`
  - `TestTick_CatchUpAddsOnlyTheLatest12`: weekly, last added 20 weeks ago → the 12 most recent, oldest first
  - `TestTick_PeriodsBeforeNotBeforeAreNeverAdded`
  - `TestTick_EndsOnStopsIt`
  - `TestTick_FailedPreconditionIsSkipped`
  - `TestTick_UnavailableIsRetriedNextTick`: `last_added` unchanged
  - `TestLedgerClient_SendsBearerToken`: a fake token endpoint via `httptest`
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement and add the oauth2 dependency.
- [ ] **Step 4:** `go vet ./... && go test ./...`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pulse): add due recurring periods through the ledger with a service token`

### Task 6: Shared client logic and web

**Files:**
- Create: `packages/core/src/recurring.ts` (exported). Test: `packages/core/test/recurring.test.ts`
- Regenerate: the api-client schema; export `RecurringDto` and `RecurringWriteDto` types
- Modify (web):
  - `components/ExpenseForm.tsx`: Repeat control and an optional end date, when a new `allowRepeat` prop is set
  - `app/groups/[id]/actions.ts`:
    - `saveExpense` posts to `/recurring` when repeating;
    - new `saveRecurring`, `pauseRecurring`, `resumeRecurring` and `deleteRecurring` actions
  - `app/groups/[id]/page.tsx`: "Repeating" section
  - new `app/groups/[id]/recurring/[scheduleId]/page.tsx`: edit, pause/resume, delete

**Interfaces:**
- Produces (core):
  - `type Repeat = "none" | "weekly" | "monthly"`
  - `describeRule(frequency: "weekly" | "monthly", startsOn: string): string` → "Every Friday", "Every month on the 1st",
    "Every month on the 31st (the last day in shorter months)"
  - `toRecurringWriteDto(form: ExpenseFormState, frequency: "weekly" | "monthly", endsOn: string): RecurringWriteDto | { error: string }`:
    reuses `toExpenseWriteDto`'s validation; the start date is `form.occurredOn`; the end date can't be before it.
  - `recurringForm(dto: RecurringDto, memberIds, meId): { form: ExpenseFormState; frequency; endsOn }` for editing
  - `describeSchedule(dto: RecurringDto): string` → "R 12 000,00 · Every month on the 1st · next 1 Dec 2026" or
    "… · paused"
- [ ] **Step 1: Write failing core tests** for each function above, including `end date before start is rejected` and
  `29th–31st mention shorter months`.
- [ ] **Step 2:** `pnpm --filter @kitty/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement core, then the web screens. When editing a started schedule (`lastAddedOn` set), the date
  field is read-only.
- [ ] **Step 4:** `pnpm --filter @kitty/core test && pnpm --filter web typecheck && pnpm --filter web test && pnpm --filter web build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): repeating expenses`

### Task 7: Mobile

**Files:**
- Modify: `apps/mobile/src/components/ExpenseForm.tsx` (Repeat chips and end date, with an `allowRepeat` prop),
  `src/app/(app)/groups/[id]/expenses/new.tsx` (save as schedule when repeating), `src/app/(app)/groups/[id]/index.tsx`
  (Repeating section)
- Create: `src/app/(app)/groups/[id]/recurring/[scheduleId].tsx`
- Test: `apps/mobile/test/recurring.test.tsx`

- [ ] **Step 1: Write failing tests.**
  - `repeat monthly posts a schedule, not an expense`
  - `the rule line follows the date`
  - `group home lists repeating schedules with next due`
  - `pause and resume call the ledger and refresh`
  - `a started schedule's date is read-only`
- [ ] **Step 2:** `pnpm --filter mobile test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter mobile test && pnpm --filter mobile typecheck && pnpm --filter mobile export`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mobile): repeating expenses`

### Task 8: Keycloak, Aspire, compose, CI, docs

**Files:**
- Modify: `infra/keycloak/kitty-realm.json`. Add client `kitty-pulse`:
  - confidential, `serviceAccountsEnabled: true`, standard and direct flows off;
  - secret `${PULSE_CLIENT_SECRET:dev-only-kitty-pulse-secret}`;
  - the `kitty-ledger` audience mapper as on the other clients.
- Modify: `aspire/Kitty.AppHost/AppHost.cs`.
  - The ledger gets a second endpoint, `grpc`: HTTP/2, `Ledger__GrpcPort` from the endpoint.
  - pulse gets:
    - `PULSE_KAFKA_BOOTSTRAP` and `PULSE_SCHEMA_REGISTRY_URL`, the same fixed values as ai;
    - `PULSE_LEDGER_GRPC` (ledger `grpc` endpoint);
    - `PULSE_TOKEN_URL` (`{keycloak}/realms/kitty/protocol/openid-connect/token`);
    - `PULSE_CLIENT_SECRET` = `dev-only-kitty-pulse-secret`;
    - `WaitFor(redpanda)` and `WaitFor(keycloak)`, but not the ledger.
- Modify: `deploy/compose/docker-compose.yml`.
  - Ledger: `Ledger__GrpcPort: "8082"`.
  - pulse: the new env vars, with `PULSE_LEDGER_GRPC=ledger:8082` and the token URL `http://keycloak:8080/auth/realms/kitty/...` matching the compose Keycloak path; `depends_on` redpanda and keycloak.
  - `.env.example`: `PULSE_CLIENT_SECRET`.
  - `RUNBOOK.md`: "Upgrading to recurring expenses (3b)", which adds the `kitty-pulse` client by import as in 2c.
- Modify: `README.md` (What it does), `services/pulse/README.md` (new env vars).
- [ ] **Step 1:** Make the changes. `docker compose config` is valid; the AppHost builds.
- [ ] **Step 2: Verify locally** with Aspire:
  - create a monthly schedule starting today on web;
  - within a minute the expense appears, dated today, with "added automatically" in the activity feed;
  - pause it;
  - restart pulse: nothing new;
  - check the mobile app shows the Repeating list.
- [ ] **Step 3: Compose smoke** (throwaway project as in 3a): pulse starts healthy with the new env vars.
- [ ] **Step 4: Commit** `ci(pulse): run recurring expenses under Aspire and compose`

## Self-review notes
- Spec coverage:
  - §2 goals → Tasks 1–7
  - §3.2 → Tasks 2–3
  - §3.3 → Tasks 4–5
  - §3.4 → Tasks 6–7
  - §3.5 → Task 8
- Anti-goals:
  - "added twice" → T3 and T5 tests
  - "ledger trusting pulse" → the T3 precondition theory and permission test
  - "reachable from outside" → the T3 `RequireHost` and policy, and T8 compose (8082 not routed by Caddy)
  - "rules disagree" → the T1 shared fixture
