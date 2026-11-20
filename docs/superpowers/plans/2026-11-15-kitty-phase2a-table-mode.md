# Kitty Phase 2a — Itemized Split and Live Table Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At a restaurant, the host types (or later scans) the bill's items, shows a QR code, and everyone — members on their phones or guests in a browser with no account — taps what they had, live; the host maps guests to members, locks, and confirms, creating one itemized expense.

**Architecture:** New `itemized` split method in the domain (shared fixtures C#/TS). A `ReceiptSession` aggregate in the ledger holds items, additive charges, claims and guests; mutations go through REST (idempotent, as today) and every change is broadcast over a SignalR hub to the session's group. A Redis backplane makes the hub correct across replicas. Guests get a short-lived token scoped to one session. Phase 2b adds photo upload + OCR/Gemini that fill the same session's items; 2c adds the Expo app as another client of the same API and hub.

**Tech Stack:** ASP.NET Core SignalR + `Microsoft.AspNetCore.SignalR.StackExchangeRedis`, Redis (Aspire `Aspire.Hosting.Redis` locally; Upstash or in-compose Redis in cloud), `@microsoft/signalr` (latest 10.x, to match the server), `qrcode`, plus everything from phase 1.

**Spec:** `docs/superpowers/specs/2026-11-15-kitty-design.md` — §5.2a (guests), §5.3 (itemized rule), §6 item 6 (table mode). Phase 1 plan: `docs/superpowers/plans/2026-11-15-kitty-phase1-core-ledger.md` (its Global Constraints still apply).

## Global Constraints

- Everything in phase 1's Global Constraints (integer minor units, member order, idempotency on every mutation, 404 for non-members, soft deletes + audit, ProblemDetails `code`).
- **Itemized rule (spec §5.3):** each item's line total splits equally among its claimers; unclaimed items split equally among all participants; additive charges (tip, service charge, delivery) are distributed proportionally to each participant's item subtotal. Every split floors, then gives leftover minor units +1 in member order. Shares always sum exactly to items + charges.
- **South Africa:** menu prices include VAT, so VAT is never an additive charge. Charges are only `tip`, `service`, `delivery`, `other`, each ≥ 0.
- **Guests (spec §5.2a):** a guest token is 32 random bytes (base64url), stored only as a SHA-256 hash, valid for one session, until the session is confirmed or 24 h pass. A guest sees only that session's items, charges and claimers' display names — never balances, members' payment details or anything else in the group.
- A session is `open` → `locked` → `confirmed` (or `cancelled`). Only `open` sessions accept item edits and claims; only the host edits items, locks, maps guests, confirms or cancels. Confirming creates exactly one expense (idempotent) with `split.method = "itemized"`, payer = host by default.
- Every state change is broadcast on the hub; the REST response is the source of truth and clients re-fetch on reconnect.

## Review Focus

1. **Two people tap the same item at the same moment** → both claims exist (shared item), never one silently lost. (Task 4 `Concurrent_claims_on_one_item_both_survive`.)
2. **Guest token used on another session, after confirm, or after 24 h** → 404 / 409, and a guest can never call any `/groups/...` route. (Task 5 tests.)
3. **Host confirms while someone is still claiming** → claims after `locked` get 409 `session_locked`; the confirmed expense matches the locked state exactly. (Task 4 `Claim_after_lock_returns_409`.)
4. **Items + charges with awkward remainders** (R100 tip on three uneven subtotals; one item shared three ways; everything unclaimed) → shares sum exactly; same answer in C# and TS. (Task 1 fixtures.)
5. **Phone sleeps / loses signal at the table** → the client reconnects and re-fetches the session; no stale UI. (Task 7 `useTableSession` reconnect test.)

---

## File Structure

```
contracts/fixtures/itemized.json
services/ledger/src/Kitty.Ledger/
  Domain/Splits/ItemizedSplitCalculator.cs
  Data/Entities/ReceiptSession.cs            (ReceiptSession, ReceiptItem, ReceiptCharge, ItemClaim, Guest)
  Data/Migrations/*_ReceiptSessions.cs
  Features/Table/TableDtos.cs  TableEndpoints.cs  GuestEndpoints.cs  GuestAuth.cs  TableHub.cs  TableBroadcaster.cs
services/ledger/tests/...UnitTests/ItemizedSplitCalculatorTests.cs  ItemizedFixtureTests.cs
services/ledger/tests/...IntegrationTests/TableSessionTests.cs  GuestTests.cs  TableHubTests.cs
packages/money/src/itemized.ts  packages/money/test/itemized.test.ts
apps/web/src/lib/table-client.ts  apps/web/src/hooks/useTableSession.ts
apps/web/src/app/groups/[id]/table/new/page.tsx
apps/web/src/app/groups/[id]/table/[sessionId]/page.tsx      (host view)
apps/web/src/app/t/[sessionId]/page.tsx                       (claim view: member or guest)
apps/web/src/components/TableItems.tsx  QrCode.tsx
aspire/Kitty.AppHost/AppHost.cs (Redis)   deploy/compose/docker-compose.yml (Redis)
```

---

### Task 1: Itemized split calculator (C# + TS, shared fixtures)

**Interfaces:**
- `record ItemInput(Guid ItemId, long LineTotalMinor, IReadOnlyList<Guid> ClaimerIds)`
- `static SplitResult ItemizedSplitCalculator.Calculate(IReadOnlyList<ItemInput> items, long chargesMinor, IReadOnlyList<Guid> participants)` → shares in member order summing to Σitems + charges; errors `split_empty` (no participants), `split_invalid_value` (negative amounts, claimer not a participant).
- TS `previewItemized(items, chargesMinor, participants)` in `@kitty/money`, same results.
- `contracts/fixtures/itemized.json`, same shape idea as `splits.json`.

- [ ] **Step 1:** Write fixtures + failing tests: one item per person; one item shared by three (remainder in member order); unclaimed item split among all; R100 tip across subtotals 120/80/0 (the zero-subtotal participant pays only their share of unclaimed items, no tip share); all unclaimed; claimer outside participants → error. FsCheck property: shares always sum to Σitems + charges.
- [ ] **Step 2:** Run C# and TS tests → FAIL.
- [ ] **Step 3:** Implement both (reuse `MemberOrder` / `compareMemberIds`; charges via the same floor + member-order distribution, weighted by subtotal; if every subtotal is 0, charges split equally).
- [ ] **Step 4:** Run → PASS. **Step 5:** Commit `feat: itemized split calculator with shared fixtures`.

### Task 2: Receipt session persistence

**Interfaces:**
- `ReceiptSession { Id, GroupId, HostUserId, PayerMemberId, Currency, Title, Status (open|locked|confirmed|cancelled), ExpenseId?, Version (concurrency token), CreatedAt, UpdatedAt }`
- `ReceiptItem { Id, SessionId, Description (1–80), Quantity (1–99), LineTotalMinor (≥0), Position }`
- `ReceiptCharge { Id, SessionId, Kind (tip|service|delivery|other), AmountMinor (≥0) }`
- `ItemClaim { ItemId, ClaimantKind (member|guest), ClaimantId }` PK `(ItemId, ClaimantKind, ClaimantId)` — composite key makes concurrent claims of the same item by different people both succeed and a double-tap idempotent.
- `Guest { Id, SessionId, DisplayName (1–40), TokenHash (64, unique), MappedMemberId?, ExpiresAt }`
- Migration `ReceiptSessions`.

- [ ] Failing schema test (`Duplicate_claim_by_same_person_is_rejected_by_key`), implement, migrate, PASS, commit `feat(ledger): receipt session model`.

### Task 3: Itemized expenses

**Interfaces:** `SplitMethod.Itemized` added; expenses created from a confirmed session store shares computed by Task 1 and `ReceiptSessionId`; `PUT` on an itemized expense returns 409 `edit_in_table` (edit the session instead — out of scope for 2a: itemized expenses are delete-and-redo). OpenAPI + TS client regenerated.

- [ ] Tests: `Itemized_expense_cannot_be_edited_directly`, existing expense tests still pass. Implement, regenerate contract, commit.

### Task 4: Table session API (host + members)

**Interfaces (all under the `/groups/{groupId}` member filter):**
- `POST /table-sessions {id, title, currency, payerMemberId}` → 201 `TableSessionDto`
- `GET /table-sessions/{sessionId}` → `TableSessionDto { id, title, currency, status, version, payerMemberId, items[], charges[], claims[{itemId, claimant{kind,id,displayName}}], guests[{id, displayName, mappedMemberId?}], preview: shares[] }`
- Host only (else 403 `host_only`): `PUT .../items` (replace full list, with `version` → 409 `version_conflict`), `PUT .../charges`, `POST .../lock`, `POST .../unlock`, `POST .../guests/{guestId}/map {memberId}`, `POST .../confirm` → creates the expense (all guests must be mapped → else 409 `guests_unmapped`), `POST .../cancel`.
- Any member: `PUT .../items/{itemId}/claim`, `DELETE .../items/{itemId}/claim` (idempotent).
- Errors added to the code table: `session_locked`, `session_closed`, `host_only`, `guests_unmapped`, `edit_in_table`.

- [ ] Failing tests: `Members_claim_and_preview_updates`, `Concurrent_claims_on_one_item_both_survive` (parallel requests), `Claim_after_lock_returns_409`, `Confirm_creates_one_itemized_expense_and_balances_update`, `Confirm_twice_returns_same_expense` (idempotent), `Non_host_cannot_edit_items`, `Confirm_with_unmapped_guest_returns_409`, `Non_member_gets_404`.
- [ ] Implement, PASS, audit every mutation, commit `feat(ledger): table session API`.

### Task 5: Guests

**Interfaces:**
- `POST /table-sessions/{sessionId}/join {displayName}` — anonymous, rate-limited per IP (10/min) → `{ guestId, guestToken, expiresAt }` (token returned once).
- Guest auth scheme `GuestToken` (header `Authorization: Guest <token>`): resolves to `(sessionId, guestId)`; valid only on `GET /guest/table-sessions/{sessionId}` and `PUT|DELETE /guest/table-sessions/{sessionId}/items/{itemId}/claim`. Guest DTO omits payment details and member user ids.
- The QR/link encodes `/t/{sessionId}`; members open the same link and are recognized by their normal sign-in.

- [ ] Failing tests: `Guest_can_join_view_and_claim`, `Guest_token_is_scoped_to_one_session`, `Guest_token_rejected_after_confirm`, `Guest_token_rejected_after_24h` (FakeTimeProvider), `Guest_cannot_call_group_routes` (401/404), `Guest_view_hides_payment_details`, `Join_is_rate_limited`. Implement, PASS, commit `feat(ledger): guests join table sessions by link`.

### Task 6: Live updates (SignalR + Redis)

**Interfaces:**
- Hub `/hubs/table`; auth: member JWT via `access_token` query string (standard SignalR), or guest token via `guest_token` query string. `JoinSession(sessionId)` authorizes membership/guest scope, then adds the connection to group `table:{sessionId}`.
- Server → client events: `SessionChanged { sessionId, version }` (clients re-fetch the DTO; no data in the event, so authorization stays in REST).
- `TableBroadcaster.NotifyAsync(sessionId, version)` called after every successful mutation in Tasks 4–5.
- Redis backplane when `ConnectionStrings:redis` is set; Aspire adds Redis; compose adds `redis:7-alpine` (64 MB limit, no persistence).

- [ ] Failing tests with `Microsoft.AspNetCore.SignalR.Client` against the test server: `Member_receives_change_after_claim`, `Guest_receives_change`, `Stranger_cannot_join_session_group` (hub error). Implement, PASS, commit `feat(ledger): live table updates over SignalR`.

### Task 7: Web — table mode

**Interfaces:**
- `/groups/[id]/table/new` → create session (title, currency, payer) → host page.
- Host page `/groups/[id]/table/[sessionId]`: item editor (description, qty, line total via `parseMoney`), charges (tip as amount or % of items), QR code + copy link to `/t/{sessionId}`, live claims and per-person preview (`previewItemized`), lock / map guests to members (or create a placeholder) / confirm.
- Claim page `/t/[sessionId]`: signed-in members claim as themselves; otherwise a "Join as guest" name form (guest token kept in an httpOnly cookie scoped to `/t/{sessionId}`, set by a server action). Big tap targets, avatars of claimers on each item, "your total" bar.
- `useTableSession(sessionId)`: SignalR connection with automatic reconnect; on `SessionChanged` or reconnect, re-fetch via a server action. Unit-tested with a fake connection (`reconnect triggers refetch`, `stale version event is ignored`).

- [ ] Failing vitest for `useTableSession` logic (extracted as a pure reducer + effect wrapper) and for tip-percentage parsing; implement pages; typecheck + build PASS.
- [ ] Manual check (two browsers + one private window as guest): add 4 items + 10% tip, guest and member claim live, shared item, lock, map guest to a placeholder, confirm → expense appears with itemized shares; balances update.
- [ ] Commit `feat(web): live table mode with guests`.

### Task 8: Wire-up and docs

- [ ] Aspire: add Redis, pass `ConnectionStrings__redis` to the ledger. Compose: add Redis service + ledger env; Caddy proxies WebSockets for `/api/hubs/*` (Caddy does this by default; add a smoke check that the negotiate endpoint answers). README: table mode section. Commit `chore: redis in aspire and compose, docs`.

---

## Phase 2a done when

- All suites green locally and in CI; the manual table-mode check above passes.
- A guest with no account can claim items from a QR link, and nothing outside that one session is reachable with their token.
