# Kitty Phase 3c: Notifications (push and email, sent by pulse), Design

Status: draft for owner approval. Builds on the [overall design](2026-11-15-kitty-design.md) §5.1 "pulse" and §6
feature 9, and on [3b](2026-11-24-kitty-phase3b-recurring-design.md) (pulse follows ledger topics; pulse's service token).

## 1. Intent

People find out about money in Kitty only by opening it. 3c tells them: when someone else adds them to an expense, when
a payment involving them is recorded, and (if they want) once a week what they still owe. On the phone as a push
notification, and by email.

For the portfolio it finishes pulse's three jobs: Firebase Cloud Messaging and SMTP delivery in Go, fed by events the
ledger writes in the same transaction as the change (outbox), with the access rules kept where the data is.

## 2. Goals, non-goals, anti-goals

**Goals (owner decisions in bold)**
- **The ledger decides who is told and what it says; pulse delivers.**
- **Push goes straight to Firebase Cloud Messaging (FCM HTTP v1)**, no Expo push service and no Expo account.
- Three kinds:
  - **Expense added**: someone else added an expense you're in (as payer or sharer), including table-mode confirms and
    automatically added recurring periods. "Sam added Groceries in Flat 4B · your share R 150,00".
  - **Payment**: someone else recorded a settlement you're part of. "Sam marked R 500,00 paid to you in Flat 4B".
  - **Weekly summary** (opt-in): Monday 08:00 SAST, only if you owe something. "You owe R 1 234,00 across 2 groups".
- Per-person settings: for each kind, push on/off and email on/off. Defaults: push on for expenses and payments, email
  off for both, weekly off (both channels).
- Both apps get a "Notifications" settings screen; the Android app registers its push token; tapping a notification opens
  the group.
- Email through the SMTP server Keycloak already uses (Gmail in production, Mailpit locally).

**Non-goals**
- Web push (browser notifications), iOS push (no Apple account), SMS.
- Notifying about edits and deletes, table-mode activity before confirm, or invites.
- Notifying placeholder members (no account) or the person who made the change.
- Digest/batching beyond the weekly summary; quiet hours.

**Anti-goals**
- A notification revealing anything from a group the person isn't in (overall design anti-goal). The ledger builds
  every message from the group's own data and sends it only to that group's members with accounts.
- The same notification delivered twice by Kafka redelivery or a retry. (Builder's call: delivery is recorded after the
  provider accepts it, so the only duplicate left is a crash in the moment between those two steps; a lost money
  notification would be worse than that rare duplicate.)
- A notification sent to someone who turned that kind off.
- Push tokens or email addresses outside Kitty's own services (ledger, pulse, and the internal Kafka topic between
  them) and the delivery providers: never in URLs, logs or traces. (Builder's call: the compacted topic is inside the
  same private network as the two databases, so it counts as Kitty's own store.)
- Email sent to an address the person hasn't verified, or to an old address after they changed it in Keycloak.

## 3. How it works

### 3.1 Data flow
```
ledger: expense/settlement saved ──outbox (same transaction)──▶ notifications.requested (key = user id)
ledger: settings/devices changed ──outbox──▶ ledger.notify-settings (compacted, key = user id)
pulse: keeps settings; for each request → push (FCM) and/or email (SMTP), per the person's settings, once
pulse: Mondays 06:00 UTC ──gRPC QueueWeeklySummaries(week)──▶ ledger writes one summary request per person who owes
```

### 3.2 ledger
- **Settings and devices** (per user, not per group):
  - `NotificationSettings(UserId, ExpensePush, ExpenseEmail, PaymentPush, PaymentEmail, WeeklyPush, WeeklyEmail)`,
    created with the defaults on first read.
  - `PushDevices(UserId, Token, Platform, CreatedAt, LastSeenAt)`; a token belongs to one user (re-registering it
    under another user moves it, e.g. a shared phone after sign-out/sign-in).
  - REST: `GET/PUT /me/notifications`; `POST /me/devices` `{token, platform}` (register or refresh, idempotent);
    `POST /me/devices/forget` `{token}` (sign-out). Tokens travel in bodies, never in URLs (logs and traces record
    URLs).
  - **Email address:** the ledger refreshes the user's stored email and `email_verified` from the access token
    whenever they differ (today it copies them only when the user is first seen), and republishes settings when they
    change. Only a verified address is published; otherwise email is simply unavailable for that person.
  - Every change writes the person's full delivery state to the outbox → compacted topic `ledger.notify-settings`,
    key = user id: `NotifySettingsChanged{user_id, email, settings…, push_tokens[], version}`.
- **Requests**: in the same transaction as the change, for each recipient:
  `NotificationRequested{notification_id, user_id, kind (EXPENSE_ADDED | PAYMENT | WEEKLY_SUMMARY), title, body,
  link (kitty://groups/{id}), group_id?, occurred_at}` → topic `notifications.requested`, key = user id.
  - Recipients: group members with a user account, involved in the expense (payer or share) or settlement (from or to),
    minus the acting user. For an automatically added recurring period the "actor" is nobody (the ledger passes no
    actor in that path, though the expense's creator is still the schedule's creator), so everyone involved hears about
    it ("Rent was added for this month · your share R 6 000,00").
  - Text is written by the ledger in English, money formatted like the apps (`R 150,00`), and contains only that
    group's name, the actor's display name, the description and amounts.
  - The ledger writes a request whatever the person's settings are; pulse applies them (so a settings change takes
    effect for requests already queued).
- **gRPC (pulse's service token, internal port, as 3b)**:
  - `QueueWeeklySummaries(week)`: for every user who owes in at least one group (per-currency balances, each currency
    totalled separately: "R 1 234,00 and € 20,00 across 2 groups"), write a WEEKLY_SUMMARY request with
    `notification_id` derived from (user, week) so a repeat call doesn't double it.
  - `ForgetDevice(token)`: pulse reports a token FCM says is dead; the ledger deletes it (and republishes settings).

### 3.3 pulse
- Consumes `ledger.notify-settings` into `pulse.notify_settings` (version-guarded upsert, as 3b's schedules).
- Consumes `notifications.requested`; for each, looks up the person's settings and sends on each enabled channel:
  - **Push**: FCM HTTP v1 `projects/{id}/messages:send` to each token, with title, body and the link as data; OAuth2
    with the Firebase service-account key (`golang.org/x/oauth2/google`, already in the module). A token FCM reports as
    `UNREGISTERED`/`INVALID_ARGUMENT` is forgotten (gRPC `ForgetDevice`).
  - **Email**: plain-text mail over SMTP (implicit TLS on 465, STARTTLS on 587, plain on Mailpit's 1025), From the
    configured address, with a web link built from `PULSE_WEB_URL` (the app's public address).
  - Records each (notification id, channel) it delivered in `pulse.deliveries`, so a re-read request isn't sent again;
    a transient failure (FCM 5xx/429, SMTP 4xx, network) is retried with backoff, then given up after an hour and logged.
- Scheduler: Mondays 06:00 UTC calls `QueueWeeklySummaries` for that ISO week (retried until it succeeds that day).
- Settings missing for a user (not yet received) → retry briefly, then skip with a warning.
- Push is off when no Firebase credentials are configured (logged once at start); email is off when no SMTP host is.

### 3.4 Apps
- **Mobile** (`expo-notifications`): after sign-in, ask for notification permission (Android 13+), get the FCM device
  token, `POST /me/devices`; again on start (tokens rotate); `POST /me/devices/forget` on sign-out. Tapping a notification opens
  its link. A "Notifications" screen (from the groups list header) with the six switches.
- **Web**: a "Notifications" page with the same switches (push switches say "on the Android app").
- The APK build includes Firebase's `google-services.json`, provided as a GitHub secret (base64) and written before
  `expo prebuild`; locally from a git-ignored file. Without it the app builds and push simply isn't available.

### 3.5 Running it
- **Owner setup (one time):** create a Firebase project, add an Android app `za.kitty.app`, download
  `google-services.json`, and create a service-account key for pulse. Steps go in the RUNBOOK and `apps/mobile/README.md`.
- Aspire: pulse gets SMTP = Mailpit, and Firebase credentials from user secrets when set. Compose: pulse gets the same
  `SMTP_*` as Keycloak plus `PULSE_FCM_CREDENTIALS` (the key JSON, a file mounted read-only).

## 4. Approaches considered
1. **Ledger decides, pulse sends (chosen by the owner).** Access rules stay with the data; pulse owns delivery.
2. pulse reads raw events and asks the ledger over gRPC who to tell and what happened. Two hops per event; the rules
   end up split across two services.
3. Ledger does everything. Simplest; pulse does nothing in 3c, against the overall design.

## 5. New dependencies (owner approval needed)
- Mobile: `expo-notifications` (the version Expo SDK 58 pins).
- Go and .NET: none (`golang.org/x/oauth2/google` is part of the existing `golang.org/x/oauth2` module; SMTP from Go's
  standard library).
- Accounts: a Firebase project (free Spark plan), created by the owner.

## 6. Decisions and calls (builder's unless marked)
- Delivery is at-least-once with a recorded-after-send dedupe (see the anti-goals).
- The ledger refreshes email and `email_verified` from the token; only verified addresses get email.
- Device tokens in request bodies; the internal topic may carry email and tokens (Kitty's own network).
- Default settings as in §2 (push on for expenses and payments, email off, weekly off).
- Weekly summary at 06:00 UTC on Mondays (08:00 SAST).
- Message copy in English only.
- Left to the builder: table names, exact copy, the settings screens' layout within the existing style.
