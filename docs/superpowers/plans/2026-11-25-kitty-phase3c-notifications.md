# Kitty Phase 3c — Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People are told on their phone (push) and by email when someone else adds them to an expense or records a payment
with them, and, if they opt in, once a week what they owe.

**Architecture:**
- The ledger decides who is told and writes the text. It writes one `NotificationRequested` per recipient to the
  outbox, in the same transaction as the change; these go to topic `notifications.requested`.
- Each person's delivery state goes to the compacted topic `ledger.notify-settings`. That state is their settings, their
  verified email, and their push tokens.
- pulse keeps a copy of everyone's settings. It delivers over FCM HTTP v1 and SMTP, once per notification and channel.
  It also calls two ledger gRPC methods: one queues the weekly summaries, one forgets dead tokens.

**Tech Stack:**
- .NET 10: EF Core, the outbox, and Grpc.AspNetCore
- Go 1.27: franz-go, pgx, `golang.org/x/oauth2/google`, `net/smtp`, Testcontainers (Postgres, Redpanda, Mailpit)
- Expo SDK 58: `expo-notifications`
- Next.js

**Spec:** `docs/superpowers/specs/2026-11-25-kitty-phase3c-notifications-design.md`

## Global Constraints

- **New dependency (approved with the spec):** mobile `expo-notifications@58.1.9`. Nothing else is new.
  - Go uses `golang.org/x/oauth2/google` from the existing `golang.org/x/oauth2 v0.38.0` module, and the
    `testcontainers-go` module already pinned.
- **Kinds:** `EXPENSE_ADDED`, `PAYMENT`, `WEEKLY_SUMMARY`.
- **Default settings:** push on for expense and payment; email off for both; weekly off on both channels.
- **Recipients:**
  - Only group members who have a user account.
  - Only people involved: an expense's payers and shares, or a settlement's from and to.
  - Never the acting user. Automatically added recurring periods have no actor, so everyone involved is told.
- **Message copy (exact):**
  - EXPENSE_ADDED title: `{group name}`
    - body: `{actor} added {description} · your share {money}`
    - with no actor: `{description} was added · your share {money}`
    - when the person paid and holds no share: `{actor} added {description} · you paid {money}`
  - PAYMENT title: `{group name}`
    - to you: `{actor} marked {money} paid to you`
    - from you: `{actor} marked {money} paid by you`
  - WEEKLY_SUMMARY title: `Kitty`, body `You owe {amounts joined with " and "} across {n} group(s)`, where the word is
    `group` for 1 and `groups` otherwise.
  - The link is `kitty://groups/{groupId}`, or `kitty://groups` for the weekly summary.
- **Money text** is identical to the apps' `formatMoney`. It's pinned by `contracts/fixtures/money-format.json`, which
  both C# and TypeScript tests run.
- **Weekly summary:** Mondays at 06:00 UTC. `notification_id` is a name-based UUID of `weekly:{userId}:{isoYear}-W{isoWeek}`.
- **Device tokens travel only in request bodies.** Only a verified email is published; otherwise it's empty.
- **Delivery is at-least-once.** pulse records `(notification_id, channel)` in `pulse.deliveries` after the provider
  accepts it, and skips anything already recorded.
  - Transient failures (FCM 429 or 5xx, SMTP 4xx, network) are retried with backoff for up to an hour from the request's
    `occurred_at`, then logged and dropped.
  - On FCM `UNREGISTERED` or `INVALID_ARGUMENT` for a token, pulse calls `ForgetDevice` and carries on with the other
    tokens.
- **pulse settings:**
  - `PULSE_FCM_CREDENTIALS` is a path to the service-account JSON. Empty means push is off, logged once.
  - `PULSE_SMTP_HOST`, `PULSE_SMTP_PORT`, `PULSE_SMTP_USER`, `PULSE_SMTP_PASSWORD`, `PULSE_SMTP_FROM`. An empty host
    means email is off.
  - `PULSE_WEB_URL` is required.
- Conventional commits, one logical change each. No attribution lines.

## Review Focus

1. **The wrong recipients.** A placeholder member, the person who made the change, or someone in another group must never
   be told. *Test:* Task 3 `Only_involved_members_with_accounts_except_the_actor_are_told`.
2. **The same request read twice from Kafka.** Each channel delivers once. *Test:* Task 7 `TestDispatch_RedeliveredRequestIsSentOnce`.
3. **Push turned off after a request was queued.** It isn't sent. *Test:* Task 7 `TestDispatch_AppliesCurrentSettings`.
4. **One dead phone token among two.** The dead one is forgotten through the ledger, and the other still gets the push.
   *Test:* Task 7 `TestDispatch_DeadTokenIsForgottenOthersStillSent`.
5. **The weekly summary queued twice in one week.** Each person gets one. *Test:* Task 4 `Weekly_summaries_are_queued_once_per_week`.

---

### Task 1: Contracts and money text

**Files:**
- Create:
  - `contracts/proto/kitty/notify/v1/notify.proto` (events)
  - `contracts/proto/kitty/ledger/v1/notify.proto` (gRPC `NotifyService`)
  - `contracts/fixtures/money-format.json`
- Modify:
  - `services/pulse/buf.gen.yaml`: add `kitty/notify`
  - the ledger csproj `<Protobuf>` items: `kitty/notify` → None
- Create: `services/ledger/src/Kitty.Ledger/Domain/MoneyText.cs`
- Test: `services/ledger/tests/Kitty.Ledger.UnitTests/MoneyTextFixtureTests.cs`, `packages/money/test/format-fixture.test.ts`

**Interfaces:**
- Produces (proto, package `kitty.notify.v1`, csharp `Kitty.Contracts.Notify.V1`, go `.../gen/kitty/notify/v1;notifyv1`):
  ```proto
  message NotificationRequested {
    enum Kind { KIND_UNSPECIFIED = 0; KIND_EXPENSE_ADDED = 1; KIND_PAYMENT = 2; KIND_WEEKLY_SUMMARY = 3; }
    string notification_id = 1; string user_id = 2; Kind kind = 3;
    string title = 4; string body = 5; string link = 6; string group_id = 7;
    google.protobuf.Timestamp occurred_at = 8;
  }
  message NotifySettingsChanged {
    string user_id = 1; string email = 2; // verified only, else ""
    bool expense_push = 3; bool expense_email = 4; bool payment_push = 5; bool payment_email = 6;
    bool weekly_push = 7; bool weekly_email = 8; repeated string push_tokens = 9; int64 version = 10;
  }
  ```
  - `kitty.ledger.v1.NotifyService`:
    - `QueueWeeklySummaries(QueueWeeklySummariesRequest{string week /* e.g. 2026-W48 */}) → {int32 queued}`
    - `ForgetDevice(ForgetDeviceRequest{string token}) → {}`
  - The ledger csproj item for `kitty/ledger/**` stays `Both`.
- Produces (C#): `public static class MoneyText { string Format(long minor, string currency); }`
  - Its output equals `@kitty/money`'s `formatMoney`, including the no-break spaces Intl uses.
- [ ] **Step 1:** Write the fixture: `[{minor, currency, expected}]`. Generate `expected` once with
  `node -e` from `formatMoney`, for these values:
  - ZAR 15000, 123456, 100000000 and -500
  - EUR 2000
  - USD 99
  - JPY 1000
  - GBP 123456789
- [ ] **Step 2:** Write the failing tests: `MoneyTextFixtureTests.Format_matches_the_apps` (theory over the fixture) and
  `format-fixture.test.ts`. Run both; C# fails (no `MoneyText`), TS passes (it is the source of truth).
- [ ] **Step 3:** Implement `MoneyText` with symbols from a small table: ZAR `R`, EUR `€`, USD `US$`, GBP `£`, JPY `JP¥`,
  and otherwise the ISO code followed by a no-break space. Do exactly what the fixture shows for grouping, decimal comma
  and sign.
- [ ] **Step 4:** Write the protos, then run `buf lint` and `generate`. `dotnet test` unit tests pass, and `pnpm --filter @kitty/money test` passes.
- [ ] **Step 5: Commit** `feat(notify): notification contracts and money text shared with the apps`

### Task 2: Settings, devices and email in the ledger

**Files:**
- Create:
  - `Data/Entities/NotificationSettings.cs`, `Data/Entities/PushDevice.cs`
  - `Features/Notifications/NotificationSettingsEndpoints.cs`
  - migration `NotificationSettings`
- Modify:
  - `Infrastructure/Auth/CurrentUser.cs`: refresh `Email` and the new `EmailVerified` from claims when they differ, and queue a settings event
  - `Entities.cs`: `User.EmailVerified`
  - `Outbox.cs`: `NotifySettingsChanged(Guid userId)`, which builds the full state
  - `Topics.cs`: `NotifySettings = "ledger.notify-settings"` (compacted) and `NotificationsRequested = "notifications.requested"`
  - `KafkaOptions.cs`: serializers for both new messages
  - `Program.cs`
- Test: `services/ledger/tests/Kitty.Ledger.IntegrationTests/NotificationSettingsTests.cs`. `TestTokens.For` gains an optional `bool emailVerified = true`.

**Interfaces:**
- Produces:
  - REST: `GET /me/notifications` → `NotificationSettingsDto(bool ExpensePush, bool ExpenseEmail, bool PaymentPush, bool PaymentEmail, bool WeeklyPush, bool WeeklyEmail, bool EmailAvailable)`
  - `PUT /me/notifications` takes the same fields without `EmailAvailable`.
  - `POST /me/devices` takes `{token, platform:"android"}` → 204. It moves a token already held by another user.
  - `POST /me/devices/forget` takes `{token}` → 204.
  - Every change to settings, devices, or the email or verified flag queues `NotifySettingsChanged` for that user.
    `version` is a monotonically increasing counter on the settings row.
- [ ] **Step 1: Write failing tests.**
  - `Defaults_are_push_on_for_expenses_and_payments_and_nothing_else`
  - `Saving_settings_publishes_the_full_state`: read the outbox payload and parse it
  - `A_device_registers_once_and_moves_between_users`
  - `Forgetting_a_device_removes_it_from_the_published_tokens`
  - `An_unverified_email_is_not_published`
  - `A_changed_email_in_the_token_is_refreshed_and_republished`
  - `Device_tokens_are_never_in_urls`: assert the OpenAPI document has no `{token}` route parameter
  - Add both new types to the existing Kafka round-trip pattern with `Settings_change_reaches_kafka`, using `KafkaProbe`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement and add the migration.
- [ ] **Step 4:** Run the full ledger suite plus the OpenAPI update. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ledger): notification settings, push devices and verified email, published for pulse`

### Task 3: Notification requests from expenses and payments

**Files:**
- Create: `Features/Notifications/Notifier.cs` (scoped)
- Modify:
  - `ExpenseEndpoints.CreateAsync` (actor = caller)
  - `TableEndpoints.ConfirmAsync` (actor = host)
  - `RecurringGrpcService.AddOccurrence` (actor = null)
  - `SettlementEndpoints.CreateAsync` (actor = caller)
- Test: `services/ledger/tests/Kitty.Ledger.IntegrationTests/NotificationRequestTests.cs`

**Interfaces:**
- Produces:
  - `Notifier.ExpenseAddedAsync(Expense e, Guid? actorUserId, CancellationToken ct)`
  - `Notifier.PaymentAsync(Settlement s, Guid actorUserId, CancellationToken ct)`
  - Both queue `NotificationRequested` (key = user id, `notification_id` a new UUID) before the caller's SaveChanges, using the copy rules in Global Constraints.
  - For a share, `money` is that member's share. For a payer with no share, it's the amount they paid.
- [ ] **Step 1: Write failing tests.** Each reads `notifications.requested` outbox rows.
  - `Only_involved_members_with_accounts_except_the_actor_are_told`: a group of an owner, a joined member, a
    placeholder and a non-involved joined member, plus an expense in another group → exactly the involved joined member
  - `Expense_text_names_actor_description_and_share`: `Owner added Groceries · your share R 150,00`, title = group name
  - `Recurring_periods_tell_everyone_involved_including_the_creator`
  - `Table_confirm_tells_the_claimers`
  - `A_payment_tells_the_other_party`: `Owner marked R 500,00 paid to you`
  - `Requests_reach_kafka_keyed_by_user`: a Kafka round-trip
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Full ledger suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ledger): tell the people involved when an expense or payment is added`

### Task 4: `NotifyService` over gRPC

**Files:**
- Create: `Features/Notifications/NotifyGrpcService.cs`
- Modify: `Program.cs` (map it beside `RecurringGrpcService`, with the same host and policy)
- Test: `services/ledger/tests/Kitty.Ledger.IntegrationTests/NotifyGrpcTests.cs`

**Interfaces:**
- Produces:
  - `QueueWeeklySummaries(week)`:
    - for every user with a negative per-currency net in any group, queue one `WEEKLY_SUMMARY`;
    - amounts are summed per currency across groups, and currencies are listed in ordinal order;
    - the id is the name-based UUID, and a request is skipped when an outbox row with that id already exists;
    - returns the count queued.
  - `ForgetDevice(token)`: deletes the device if present, republishes that user's settings, and is idempotent.
  - A bad week string gives `INVALID_ARGUMENT`.
- [ ] **Step 1: Write failing tests.**
  - `Weekly_summary_lists_what_each_person_owes_across_groups`: `You owe R 150,00 and € 20,00 across 2 groups`
  - `Weekly_summaries_are_queued_once_per_week`
  - `No_summary_for_someone_who_owes_nothing`
  - `Forget_device_removes_and_republishes`
  - `A_user_token_is_permission_denied`
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Full ledger suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ledger): weekly summaries and forgetting dead devices for pulse`

### Task 5: pulse keeps everyone's delivery settings

**Files:**
- Create:
  - `services/pulse/internal/kafkaconsume/consume.go`, with `Run(ctx, client, handle func(ctx, value []byte) error)`. It moves 3b's loop, header stripping and poison-record handling here. A handler error of type `Skip` is logged and committed.
  - `services/pulse/internal/notify/settings.go` (store and decode)
- Modify: `internal/recurring/consumer.go` to use `kafkaconsume`, with no behaviour change (3b's tests stay green).
- Test: `services/pulse/internal/notify/settings_test.go` (Testcontainers Postgres)

**Interfaces:**
- Produces:
  - `type Settings struct { UserID, Email string; ExpensePush, ExpenseEmail, PaymentPush, PaymentEmail, WeeklyPush, WeeklyEmail bool; Tokens []string; Version int64 }`
  - `OpenStore(ctx, url) (*Store, error)`, which creates `pulse.notify_settings` and `pulse.deliveries(notification_id uuid, channel text, delivered_at timestamptz, PRIMARY KEY(notification_id, channel))`
  - `(*Store).Upsert(ctx, Settings) error`: only a newer version wins
  - `(*Store).Get(ctx, userID) (Settings, bool, error)`
  - `(*Store).Delivered(ctx, id, channel) (bool, error)`
  - `(*Store).MarkDelivered(ctx, id, channel) error`
  - `DecodeSettings(value []byte) (Settings, error)`
- [ ] **Step 1: Write failing tests.**
  - `TestSettings_NewerVersionWins`
  - `TestSettings_TokensAndEmailRoundTrip`
  - `TestDeliveries_MarkThenDelivered`
- [ ] **Step 2:** `go test ./internal/notify/`. Expected: FAIL.
- [ ] **Step 3:** Implement; refactor recurring.
- [ ] **Step 4:** `go vet ./... && go test ./...`. Expected: PASS, with 3b's consumer tests unchanged.
- [ ] **Step 5: Commit** `feat(pulse): keep each person's notification settings`

### Task 6: Push and email senders

**Files:**
- Create: `services/pulse/internal/notify/fcm.go`, `services/pulse/internal/notify/smtp.go`
- Test: `fcm_test.go` (`httptest`), `smtp_test.go` (Testcontainers Mailpit `axllent/mailpit:v1.33.1`, read back with its API)

**Interfaces:**
- Produces:
  - `type Message struct { Title, Body, Link string }`
  - `type PushResult int` with values `PushSent`, `PushDeadToken` and `PushRetry`
  - `type Pusher interface { Push(ctx, token string, m Message) (PushResult, error) }`
  - `NewFCM(credentialsJSON []byte, baseURL string) (Pusher, error)`:
    - project id from the JSON, OAuth scope `https://www.googleapis.com/auth/firebase.messaging`;
    - POSTs `{message:{token, notification:{title, body}, data:{link}, android:{priority:"HIGH"}}}` to `{baseURL}/v1/projects/{id}/messages:send`.
  - `type Mailer interface { Send(ctx, to string, m Message) error }`
  - `NewSMTP(host string, port int, user, password, from, webURL string) Mailer`:
    - port 465 uses implicit TLS, 587 uses STARTTLS, anything else is plain;
    - the body is `{Body}\n\nOpen Kitty: {webURL}{path from Link}`;
    - the subject is `{Title}: {Body}`, cut at 120 characters.
  - `IsTransient(err error) bool` for SMTP: a 4xx code or a network error.
- [ ] **Step 1: Write failing tests.**
  - `TestFCM_SendsMessageWithBearerToken`: a fake token endpoint and a fake FCM, asserting the JSON body
  - `TestFCM_UnregisteredIsDeadToken`: a 404 with `"errorCode":"UNREGISTERED"` in details
  - `TestFCM_ServerErrorIsRetry`
  - `TestSMTP_SendsToMailpit`: subject, body and the link
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `go test ./internal/notify/`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pulse): Firebase push and SMTP email senders`

### Task 7: Dispatch, weekly timer and wiring

**Files:**
- Create: `services/pulse/internal/notify/dispatch.go`, `services/pulse/internal/notify/weekly.go`
- Modify:
  - `internal/recurring/ledgerclient.go`: expose the token-carrying gRPC connection so notify reuses it (Ruling-free refactor: `NewLedgerConn`)
  - `cmd/pulse/main.go`: two more consumers, the weekly loop, and the new env vars
- Test: `services/pulse/internal/notify/dispatch_test.go` (fakes for the store, Pusher, Mailer and Ledger), `weekly_test.go`

**Interfaces:**
- Produces:
  - `type Ledger interface { ForgetDevice(ctx, token string) error; QueueWeeklySummaries(ctx, week string) error }`
  - `type Dispatcher struct { Store Deliveries; Settings SettingsReader; Push Pusher /* nil = off */; Mail Mailer /* nil = off */; Ledger Ledger; Now func() time.Time }`
  - `func (d *Dispatcher) Handle(ctx, value []byte) error`:
    - decodes the request;
    - settings missing → retry up to 30 s, then `Skip`;
    - for each enabled channel not yet delivered: push to every token (a dead token calls `ForgetDevice` and continues; if at least one is sent, mark it), or email if there is an address;
    - a transient error is retried with backoff until `occurred_at + 1h`, then `Skip`.
  - `func RunWeekly(ctx, l Ledger, now func() time.Time)`: on Mondays at or after 06:00 UTC, calls `QueueWeeklySummaries(isoWeek)` once per week, kept in memory and retried each minute until it succeeds. The ledger's idempotency makes a restart harmless.
- [ ] **Step 1: Write failing tests.**
  - `TestDispatch_SendsPushAndEmailPerSettings`
  - `TestDispatch_AppliesCurrentSettings`
  - `TestDispatch_RedeliveredRequestIsSentOnce`
  - `TestDispatch_DeadTokenIsForgottenOthersStillSent`
  - `TestDispatch_TransientErrorRetriesThenGivesUpAfterAnHour`: fake clock
  - `TestDispatch_NoEmailAddressSkipsEmail`
  - `TestWeekly_QueuesOnMondayAfterSixUTCOnce`
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement and wire `main`. `PULSE_WEB_URL` is required; push and email are optional, each logged once when off.
- [ ] **Step 4:** `go vet ./... && go test ./...`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pulse): deliver notifications once per channel, and the weekly summary`

### Task 8: Settings screens (web)

**Files:**
- Regenerate: the api-client schema
- Create:
  - `packages/core/src/notifications.ts` (`NOTIFICATION_ROWS`: label, push field, email field) and its test
  - `apps/web/src/app/settings/notifications/page.tsx` with a server action
- Modify: the groups list header gets a "Notifications" link

**Interfaces:**
- Produces (core): `NOTIFICATION_ROWS: readonly { kind: "expense"|"payment"|"weekly"; label: string; push: keyof NotificationSettingsDto; email: keyof NotificationSettingsDto }[]`, with labels:
  - "Someone adds you to an expense"
  - "A payment with you is recorded"
  - "Weekly: what you owe (Mondays)"
- [ ] **Step 1:** Failing core test: `rows cover every setting once`.
- [ ] **Step 2:** Implement.
  - The web page has a checkbox per cell.
  - The push column says "on the Android app".
  - When `emailAvailable` is false, the email checkboxes are disabled, with "Verify your email address to get email".
- [ ] **Step 3:** `pnpm --filter @kitty/core test && pnpm --filter web typecheck && pnpm --filter web test && pnpm --filter web build`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(web): notification settings`

### Task 9: Mobile push

**Files:**
- Modify:
  - `apps/mobile/package.json`: `expo-notifications@58.1.9`
  - `apps/mobile/app.config.ts`:
    - plugin `expo-notifications`;
    - `android.googleServicesFile`: the `GOOGLE_SERVICES_JSON` env path, or `./google-services.json` when that file exists, else unset;
    - `.gitignore` gets `apps/mobile/google-services.json`.
  - `.github/workflows/android.yml`: when `secrets.GOOGLE_SERVICES_JSON_BASE64` is set, write the file before prebuild
- Create:
  - `apps/mobile/src/notifications/registerDevice.ts`
  - `apps/mobile/src/notifications/useNotificationLinks.ts`: tapping opens `link` through expo-router
  - `apps/mobile/src/app/(app)/notifications.tsx` (settings screen)
- Modify: `apps/mobile/src/auth/AuthProvider.tsx`: forget the device on sign-out; register after sign-in and on app start
- Test: `apps/mobile/test/notifications.test.tsx`. `expo-notifications` is mocked in `test/setup.ts`.

**Interfaces:**
- Produces:
  - `registerDevice(ledger, notifications = ExpoNotifications): Promise<"registered" | "denied" | "unavailable">`:
    - asks for permission;
    - `getDevicePushTokenAsync()` → `POST /me/devices`;
    - "unavailable" when there's no Firebase config, i.e. the token call throws.
  - `forgetDevice(ledger)`
- [ ] **Step 1: Write failing tests.**
  - `registers the FCM token after permission is granted`
  - `denied permission registers nothing`
  - `sign-out forgets the device`
  - `tapping a notification opens its group`
  - `the settings screen saves a switch`
- [ ] **Step 2:** `pnpm --filter mobile test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter mobile test && pnpm --filter mobile typecheck && pnpm --filter mobile export`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mobile): push notifications`

### Task 10: Running it, Firebase setup and an end-to-end check

**Files:**
- Modify:
  - `aspire/Kitty.AppHost/AppHost.cs`:
    - pulse gets `PULSE_SMTP_HOST`/`PORT` from Mailpit's smtp endpoint (unproxied, plain);
    - `PULSE_WEB_URL=http://localhost:3000`;
    - `PULSE_FCM_CREDENTIALS` from user secret `Parameters:fcm-credentials-path` when set.
  - `deploy/compose/docker-compose.yml`:
    - pulse gets the `SMTP_*` values Keycloak uses, plus `PULSE_WEB_URL=https://${KITTY_HOST}`;
    - `PULSE_FCM_CREDENTIALS=/secrets/fcm.json`, mounted read-only from `${FCM_CREDENTIALS_FILE:-./fcm.json}` only when present.
  - `.env.example`, `RUNBOOK.md` ("Notifications (3c)", with the Firebase one-time setup)
  - `apps/mobile/README.md`: how to put `google-services.json` in place locally and in GitHub secrets
  - `README.md`, `services/pulse/README.md`
- [ ] **Step 1:** Make the changes. `docker compose config` is valid; the AppHost builds.
- [ ] **Step 2: Verify locally** with Aspire and Mailpit:
  - two accounts in one group;
  - the second one turns on email for expenses;
  - the first adds an expense;
  - the mail arrives in Mailpit with the right text and link, and only once;
  - the weekly summary is triggered through the gRPC method and arrives.
  - Push is verified only once the owner has set up Firebase; otherwise the log says push is off.
- [ ] **Step 3: Compose smoke** in a throwaway project: pulse is healthy with email configured and push off.
- [ ] **Step 4: Commit** `ci(pulse): run notifications under Aspire and compose; Firebase setup guide`

## Self-review notes
- Spec coverage:
  - §2 kinds and defaults → Tasks 2, 3, 4, 7
  - §3.2 → Tasks 2–4
  - §3.3 → Tasks 5–7
  - §3.4 → Tasks 8–9
  - §3.5 → Task 10
- Anti-goals:
  - other groups → the T3 recipients test
  - twice → the T7 redelivery test
  - setting off → the T7 current-settings test
  - tokens in URLs → the T2 OpenAPI test
  - unverified or old email → the T2 tests
