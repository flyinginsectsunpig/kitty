# Kitty Phase 4a: Plain-Language Entry and Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One sentence becomes a confirmable expense draft or a reminder, on web and Android; reminders also get a button and a notification kind.

**Architecture:**
- The app calls the ai service (`/ai/parse`, `/ai/resolve`) with the person's Keycloak token.
- The ai service checks the token, reads the ledger as that person, asks the model (Gemini or Ollama, schema-checked, sentence only), matches names locally, and returns a draft.
- The ledger gains `POST /groups/{groupId}/reminders` and a REMINDER notification kind, which pulse delivers.

**Tech Stack:** Python 3.13 FastAPI + google-genai + PyJWT; .NET 10 ledger; Go pulse; Next.js web; Expo mobile; Keycloak; Caddy.

**Spec:** `docs/superpowers/specs/2026-11-25-kitty-phase4a-plain-language-entry-design.md`

## Global Constraints

- **Nothing is written or sent without a tap:**
  - `/ai/parse` and `/ai/resolve` never call a ledger write;
  - Save uses the existing `POST /groups/{groupId}/expenses`;
  - Send and Remind use `POST /groups/{groupId}/reminders`.
- **What the model sees:** the sentence, today's date in Africa/Johannesburg (`YYYY-MM-DD`), and the default currency code. Never group names, member names, ids or balances.
- **Money:** decimal strings from the model, converted with `kitty_ai.currencies.exponent` using `decimal.Decimal`. Never `float`.
- **The ai service reads the ledger only with the caller's token:** `GET /me`, `GET /groups`, `GET /groups/{id}`, `GET /groups/{id}/balances`.
- **Token check:**
  - issuer `AI_AUTH_ISSUER`, audience `AI_AUTH_AUDIENCE` (default `kitty-ai`);
  - RS256 keys from `{issuer}/protocol/openid-connect/certs`;
  - 30 s clock skew;
  - errors are 401 `{"code":"unauthorized"}`.
- **Limits:**
  - parse: 30 per person per rolling hour;
  - resolve: 120 per person per hour;
  - over the limit: 429 `{"code":"rate_limited"}`.
- **Model failures:**
  - no model configured, or the provider is down: 503 `{"code":"ai_unavailable"}`;
  - output that fails the schema: 422 `{"code":"unclear"}`.
- **Logs:** never the sentence. Only the intent, the timing and the person's subject.
- **Categories (exact):** `food, groceries, transport, accommodation, utilities, rent, entertainment, shopping, other`. Default `other`.
- **Reminders:**
  - the amount comes from the transfers from that member to the caller in `GET /groups/{id}/balances`, per currency;
  - one per (group, from member, to member, UTC date);
  - errors: 409 `nothing_owed`, 409 `no_account`, 429 `already_reminded`.
- **Reminder copy:**
  - title = group name;
  - body `"{Sender} reminded you: you owe them {amounts joined " and "}"`;
  - link `kitty://groups/{groupId}`.
- **Reminder settings:**
  - push on, email off by default;
  - row label `"Someone reminds you what you owe"`;
  - fields `reminderPush`, `reminderEmail`;
  - proto fields `reminder_push = 11`, `reminder_email = 12`, `KIND_REMINDER = 4`.
- **Card copy:**
  - privacy line: `"Your sentence is sent to Google's Gemini to read it."`;
  - reminder mismatch: `"You said {stated}; Kitty's balance says {owed}."`.
- **Routes:** Caddy `handle_path /ai/*` → `ai:8000`. The mobile setting is `EXPO_PUBLIC_AI_URL` (default `http://localhost:5085`). The web setting is `AI_URL`. The Aspire ai port is fixed at `5085`.
- **New dependency:** `pyjwt[crypto]`, exact-pinned, as the design allows. No others without asking.

## Review Focus

1. **"split with Sam and Ana":** the speaker is in the split. Expect you, Sam and Ana sharing equally. Pinned by the prompt plus the labelled set (Task 6). The resolver also adds the speaker to an equal split when the payer is the speaker and fewer than two people are named (Task 5, `test_equal_split_with_one_name_includes_the_speaker`).
2. **SA number formats** ("R2 000", "R1 500,50", "2,000"): never a wrong amount. The converter accepts only `^\d+(\.\d+)?$` with at most the currency's exponent decimals; anything else makes the draft carry a `missing` issue on `amount` (Task 4, `test_converter_rejects_grouped_or_comma_numbers`).
3. **A sentence in another currency** ("€30 lunch"): the draft keeps EUR and the card shows it. Save goes through the ledger's normal FX (Task 5, `test_foreign_currency_is_kept`).
4. **A reminder when the debt is in two currencies:** one message joining both (Task 2, `Reminder_lists_every_currency_owed`).
5. **A token without the `kitty-ai` audience** (a deployed realm not yet updated): 401 `unauthorized`, never a 500 (Task 3, `test_wrong_audience_is_401`).

---

### Task 1: Reminder notification kind and settings (contracts, ledger settings, pulse, core rows)

**Files:**
- Modify:
  - `contracts/proto/kitty/notify/v1/notify.proto` (`KIND_REMINDER = 4`; `bool reminder_push = 11; bool reminder_email = 12;`);
  - regenerated Go `services/pulse/gen/kitty/notify/v1/*` (`go tool -modfile=tools.go.mod buf generate`).
- Ledger:
  - `Data/Entities/NotificationSettings.cs`: `ReminderPush = true`, `ReminderEmail = false`;
  - migration `ReminderSettings`;
  - `NotificationSettingsEndpoints.cs` DTOs: `ReminderPush`, `ReminderEmail`;
  - `NotifySettingsPublisher.cs`: publish both;
  - `NotifySettingsBackfill.cs`: also re-publishes everyone whose settings row has `RemindersPublished = false` (a new bool column, default false), setting it true. That way pulse learns the reminder defaults once, without waiting for each person's next change.
- pulse:
  - `internal/notify/settings.go`: `ReminderPush, ReminderEmail` fields, columns added with `ALTER TABLE … ADD COLUMN IF NOT EXISTS … DEFAULT`, decode;
  - `dispatch.go` `wants`: `KIND_REMINDER` → reminder fields.
- Core:
  - `packages/core/src/notifications.ts`: a fourth row `{ kind: "reminder", label: "Someone reminds you what you owe", push: "reminderPush", email: "reminderEmail" }`;
  - regenerate `packages/api-client/src/schema.d.ts`.
- Test:
  - ledger `NotificationSettingsTests.cs`;
  - pulse `settings_test.go`, `dispatch_test.go`;
  - core `notifications.test.ts`.

**Interfaces:**
- Produces:
  - `Kind.Reminder`;
  - DTO fields `reminderPush` / `reminderEmail`;
  - pulse `Settings.ReminderPush/ReminderEmail`.

- [ ] **Step 1: Failing tests.**
  - Ledger `Defaults_are_push_on_for_expenses_and_payments_and_nothing_else`: the expected record gains `ReminderPush: true, ReminderEmail: false`.
  - Ledger `Saving_settings_publishes_the_full_state`: asserts `e.ReminderPush`/`e.ReminderEmail`.
  - pulse `TestDispatch_ReminderUsesReminderSettings`: a REMINDER request with `ReminderEmail: true, ReminderPush: false` sends email only.
  - pulse `TestSettings_TokensAndEmailRoundTrip`: also round-trips the reminder flags.
  - Core `rows cover every setting once`: the expected list gains `reminderEmail`, `reminderPush`.
- [ ] **Step 2:** Run each suite. Expected: FAIL.
- [ ] **Step 3:** Implement the changes listed under Files.
- [ ] **Step 4:** `dotnet test` (ledger), `go vet ./... && go test ./...` (pulse), `corepack pnpm --filter @kitty/core test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: reminder notifications kind and settings`

### Task 2: Ledger reminders endpoint

**Files:**
- Create:
  - `Features/Reminders/ReminderEndpoints.cs`;
  - entity `Reminder(GroupId, FromMemberId, ToMemberId, Day: DateOnly, CreatedAt)` with key `(GroupId, FromMemberId, ToMemberId, Day)`;
  - migration `Reminders`.
- Modify:
  - `Notifier.cs`: `ReminderAsync(Guid groupId, Member from, Member to, IReadOnlyList<(string Currency, long Minor)> owed, CancellationToken)`;
  - `Program.cs`: map the endpoint;
  - `ErrorCodes`: `NothingOwed = "nothing_owed"`, `NoAccount = "no_account"`, `AlreadyReminded = "already_reminded"`;
  - regenerate `services/ledger/openapi/ledger.json` and the api-client.
- Test: `tests/Kitty.Ledger.IntegrationTests/ReminderTests.cs`.

**Interfaces:**
- Consumes: `Kind.Reminder` (Task 1).
- Produces: `POST /groups/{groupId}/reminders` with body `{ memberId: uuid }` and Idempotency-Key.
  - 204 when queued;
  - 404 when the caller isn't in the group, or the member isn't in it;
  - 409 `nothing_owed` / `no_account`;
  - 429 `already_reminded`.
  - Owed amounts come from the same balance computation `GET /groups/{id}/balances` uses (its `transfers`, filtered to from = member, to = caller).

- [ ] **Step 1: Failing tests:**
  - `Reminder_tells_the_debtor_what_the_settle_up_plan_says`: the friend owes the owner R 150,00. The owner reminds them; one REMINDER request for the friend, title "Flat 4B", body `"Owner reminded you: you owe them R 150,00"`, link `kitty://groups/{id}`.
  - `Reminder_lists_every_currency_owed`: owes €20,00 and R 150,00 in one group. Body `"… you owe them €20,00 and R 150,00"` (ordinal currency order).
  - `Nothing_owed_is_409`: the owner reminds someone who owes nothing.
  - `A_placeholder_cannot_be_reminded`: 409 `no_account`.
  - `Twice_a_day_is_429_but_another_creditor_may_remind`:
    - the owner reminds twice and gets 429 `already_reminded`;
    - a third member the friend also owes reminds once and gets 204;
    - the next day (the factory's FakeTimeProvider advances a day), the owner gets 204.
  - `Someone_outside_the_group_gets_404`.
- [ ] **Step 2:** `dotnet test --filter ReminderTests`. Expected: FAIL (404 route).
- [ ] **Step 3:** Implement. On a unique violation from a race on the Reminders key, return 429 `already_reminded`.
- [ ] **Step 4:** Full ledger suite. Expected: PASS. Regenerate OpenAPI and the client. `corepack pnpm --filter web typecheck` passes.
- [ ] **Step 5: Commit** `feat(ledger): remind someone what they owe you`

### Task 3: ai service: signed-in requests, reading the ledger as the person, limits

**Files:**
- Modify:
  - `services/ai/pyproject.toml` (add `pyjwt[crypto]` exact pin, `uv lock`);
  - `src/kitty_ai/settings.py`: `ledger_url: str = ""`, `auth_issuer: str = ""`, `auth_audience: str = "kitty-ai"`.
- Create:
  - `src/kitty_ai/auth.py`: `TokenVerifier(issuer, audience, fetch_jwks: Callable[[], dict], now=time.time)`, with `.verify(token) -> Caller(sub: str, token: str)`. JWKS is cached and refetched once when a `kid` is unknown.
  - `src/kitty_ai/ledger.py`: `LedgerReader(base_url, token, client: httpx.Client)`, with `me() -> Me(id, display_name)`, `groups() -> list[GroupSummary(id, name, base_currency)]`, `group(id) -> Group(id, name, base_currency, members: list[Member(id, display_name, user_id)])` and `owed_to_me(group_id, me_member_id, member_id) -> dict[str, int]` (from balances transfers). A 404 raises `NotFound`.
  - `src/kitty_ai/limits.py`: `RateLimiter(limit: int, per_seconds: int, now=time.monotonic)`, with `.allow(key) -> bool` (a sliding window in memory).
- Test: `tests/test_auth.py`, `tests/test_ledger_reader.py`, `tests/test_limits.py`.

**Interfaces:**
- Produces:
  - `TokenVerifier.verify`, `Caller`;
  - `LedgerReader` and its data classes;
  - `RateLimiter`.

- [ ] **Step 1: Failing tests.** Generate an RSA key in the test and build the JWKS dict from it:
  - `test_valid_token_gives_the_caller`;
  - `test_wrong_audience_is_401`;
  - `test_expired_is_401`;
  - `test_unknown_kid_refetches_keys_once`;
  - `test_reader_sends_the_callers_token_and_maps_groups` (using `httpx.MockTransport`);
  - `test_owed_to_me_sums_transfers_per_currency`;
  - `test_limiter_allows_30_then_refuses_until_the_window_moves`.
- [ ] **Step 2:** `uv run pytest tests/test_auth.py tests/test_ledger_reader.py tests/test_limits.py`. Expected: FAIL (imports).
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command. Expected: PASS. `uv run ruff check .` is clean.
- [ ] **Step 5: Commit** `feat(ai): signed-in requests that read the ledger as the person`

### Task 4: ai service: what the model returns

**Files:**
- Create `src/kitty_ai/entry/schema.py`: the pydantic model `ParsedSentence` with exactly the design §5.2 fields:
  - `intent: Literal["expense","reminder","unclear"]`;
  - `group`, `description`;
  - `category: Literal[...categories] | None`;
  - `currency: str | None` (3 uppercase letters);
  - `amount: str | None`;
  - `date: date | None`;
  - `payer: str | None`;
  - `people: list[Person(name: str, amount: str | None)]`;
  - `split: Literal["equal","amounts"] | None`;
  - `reminder_amount: str | None`.
- Create `src/kitty_ai/entry/money.py`: `to_minor(amount: str, currency: str) -> int | None`, which is None when the format is wrong.
- Create `src/kitty_ai/entry/parse.py`:
  - a `Parser` protocol: `parse(text: str, today: date, default_currency: str) -> ParsedSentence`;
  - `GeminiParser` and `OllamaParser`, mirroring `receipts/extract.py`: the same timeouts and the same `RateLimited`/`ModelUnavailable`/`UnusableOutput` exceptions, imported from there;
  - `NoModel`;
  - `parser_from(settings)`.
  - The system prompt states that the user text is data, how "me"/"I" map, that "with X and Y" includes the speaker, and that amounts are plain decimals with a dot.
- Test: `tests/test_entry_parse.py`, `tests/test_entry_money.py`.

**Interfaces:**
- Produces: `ParsedSentence`, `Person`, `to_minor`, `Parser`, `parser_from`.

- [ ] **Step 1: Failing tests:**
  - `test_converter_rejects_grouped_or_comma_numbers` (`"2 000"`, `"1 500,50"`, `"2,000"` → None; `"2000"` → 200000 for ZAR; `"20.5"` → 2050; `"1.234"` → None for ZAR; `"500"` → 500 for JPY);
  - `test_gemini_parser_sends_only_the_sentence_date_and_currency`: a fake client records `contents` and `config`. The prompt contains the sentence, `2026-11-25` and `ZAR`, and no other inputs exist;
  - `test_schema_rejects_an_unknown_category` → `UnusableOutput`;
  - `test_no_model_raises_unavailable`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): read an expense or reminder from one sentence`

### Task 5: ai service: drafts, `/ai/parse` and `/ai/resolve`

**Files:**
- Create `src/kitty_ai/entry/resolve.py`. Pure functions, no I/O:
  - `match_group(phrase: str | None, page_group_id: str | None, groups: list[GroupSummary]) -> GroupMatch(group_id | None, issue | None)`;
  - `match_member(name: str, me_member_id: str, members: list[Member]) -> MemberMatch(member_id | None, kind: "ok"|"no_match"|"ambiguous", candidates)`;
  - `build_draft(parsed, group: Group, me_member_id, today, owed: dict[str,int] | None) -> dict`, the design §5.5 shape:
    - `intent`, `groupId`, `expense`/`reminder`;
    - `issues`, `members`;
    - `groups` and `parsed` are added by the endpoint.
- Create `src/kitty_ai/entry/routes.py`, `make_router(settings, verifier, parser, http_client, now)`:
  - `POST /parse` `{text, groupId?}`;
  - `POST /resolve` `{parsed, groupId}`;
  - the limits and error codes from the Global Constraints;
  - text 1–500 characters, otherwise 400 `{"code":"validation_failed"}`.
- Modify `main.py`: mount the router when `settings.auth_issuer` is set.
- Test: `tests/test_entry_resolve.py`, `tests/test_entry_routes.py`.

**Interfaces:**
- Consumes: Tasks 3–4.
- Produces: the HTTP contract the apps use (design §5.5).

- [ ] **Step 1: Failing tests (resolve):**
  - `test_exact_then_first_name_then_prefix`;
  - `test_two_sams_is_ambiguous_with_both_candidates`;
  - `test_unknown_name_is_no_match`;
  - `test_me_and_i_are_the_speaker`;
  - `test_placeholders_match`;
  - `test_group_phrase_beats_page_group`;
  - `test_no_phrase_uses_page_group_else_single_group_else_issue`;
  - `test_no_people_means_everyone`;
  - `test_no_payer_means_me`;
  - `test_equal_split_with_one_name_includes_the_speaker`;
  - `test_amounts_split_totals_the_people`;
  - `test_total_and_amounts_disagree_is_mismatch`;
  - `test_foreign_currency_is_kept`;
  - `test_debt_for_bob_is_one_participant_paid_by_me` (people `[Bob 20]`, split amounts → payer me, participants `[Bob 2000]`);
  - `test_reminder_draft_carries_owed_and_stated`.
- [ ] **Step 2: Failing tests (routes)**, through FastAPI `TestClient` with a fake parser and an `httpx.MockTransport` ledger:
  - `test_parse_needs_a_token`;
  - `test_parse_returns_draft_groups_members_and_parsed`;
  - `test_resolve_rematches_without_the_model` (the fake parser asserts it isn't called);
  - `test_parse_limit_is_429`;
  - `test_model_down_is_503`;
  - `test_sentence_is_not_logged` (caplog contains no sentence text).
- [ ] **Step 3:** Run. Expected: FAIL.
- [ ] **Step 4:** Implement.
- [ ] **Step 5:** `uv run pytest && uv run ruff check .`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(ai): plain-language drafts for the apps`

### Task 6: Running it: Keycloak, Caddy, Aspire, compose, labelled set, docs

**Files:**
- Modify:
  - `infra/keycloak/kitty-realm.json`: a `kitty-ai-audience` mapper on `kitty-web` and `kitty-mobile`;
  - `deploy/compose/Caddyfile`: the `/ai/*` route;
  - `deploy/compose/docker-compose.yml`: ai env `AI_LEDGER_URL=http://ledger:8080`, `AI_AUTH_ISSUER=https://${KITTY_HOST}/auth/realms/kitty`;
  - `aspire/Kitty.AppHost/AppHost.cs`: ai fixed port 5085 via `PORT`; `AI_LEDGER_URL`, `AI_AUTH_ISSUER`; web `AI_URL`;
  - `apps/mobile/package.json` `android:reverse`: add `tcp:5085`;
  - `.github/workflows/android.yml`: `EXPO_PUBLIC_AI_URL` default `https://kitty-split.duckdns.org/ai`;
  - `deploy/compose/RUNBOOK.md` "Upgrading to 4a" (add the mapper by hand);
  - `services/ai/README.md`, `README.md`.
- Create:
  - `services/ai/evals/nl/phrases.jsonl`: about 30 lines, including the design's five, each `{text, today, currency, expect: {intent, amount?, people?, split?, group?}}`;
  - `services/ai/evals/nl/run.py`: runs the configured real model and prints intent, amount and participant accuracy; not run in CI.
- Test: a pytest that `phrases.jsonl` parses and every `expect` uses only §5.2 fields (`test_nl_evals_file.py`).

- [ ] **Step 1:** Failing test `test_nl_evals_file_is_well_formed`. Expected: FAIL (file missing).
- [ ] **Step 2:** Make the changes. `docker compose config` is valid; the AppHost builds; the Caddyfile is checked with `docker run --rm -v …:/etc/caddy caddy:2 caddy validate --config /etc/caddy/Caddyfile`.
- [ ] **Step 3:** Run the evals by hand against Gemini (`uv run python evals/nl/run.py`). Record the numbers in `services/ai/README.md`. If Gemini isn't configured locally, record "not run" and say so.
- [ ] **Step 4: Commit** `ci(ai): run plain-language entry under Aspire and compose; labelled sentences`

### Task 7: Web: the box, the card, Remind, settings row

**Files:**
- Create:
  - `packages/core/src/plain-entry.ts`:
    - the draft types matching design §5.5;
    - `draftToForm(draft, o: { id, today }) -> ExpenseFormState` (equal → participants included; amounts → method "amounts" with values in decimal text);
    - `applyPick(draft, issueIndex, memberId | null) -> draft` (null = leave out; re-totals amounts);
    - `canSave(draft) -> boolean`;
    - the test file;
  - `apps/web/src/lib/ai.ts` (server-only `parseSentence(text, groupId?)`, `resolveDraft(parsed, groupId)` calling `AI_URL` with the session's access token);
  - `apps/web/src/components/PlainEntry.tsx` (client component: box, card, issue pickers, Save, Edit, Send);
  - server actions in `apps/web/src/app/plain-entry/actions.ts`.
- Modify:
  - the groups list page and the group page (place the box);
  - the expense "new" page: accept a draft handed over in client state (sessionStorage key `kitty.draft`, read once and removed) to pre-fill;
  - the settle page: a **Remind** button per transfer to the viewer;
  - the notifications settings page picks up the new row automatically.
- Test:
  - core `plain-entry.test.ts`: `draftToForm` for each intent, `applyPick` leave-out re-totals, `canSave` false while issues are open;
  - web: a unit test for the server action's error mapping (429/503/422 → messages).

- [ ] **Step 1:** Failing core and web tests. Run. Expected: FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** `corepack pnpm --filter @kitty/core test && corepack pnpm --filter web typecheck && corepack pnpm --filter web test && corepack pnpm --filter web build`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(web): add an expense or a reminder in one sentence`

### Task 8: Mobile: the box, the card, Remind

**Files:**
- Modify `apps/mobile/src/config.ts`: `aiUrl` from `EXPO_PUBLIC_AI_URL`.
- Create:
  - `apps/mobile/src/ai.ts` (`parseSentence`, `resolveDraft` with `getAccessToken`, via `fetch`);
  - `apps/mobile/src/components/PlainEntry.tsx`.
- Modify:
  - the groups screen and the group home (place the box);
  - the expense new screen accepts a draft through router params of the draft id held in a module store (not the sentence);
  - `settle.tsx` gets a **Remind** button.
- Test: `apps/mobile/test/plain-entry.test.tsx`:
  - `a sentence shows the card and Save posts the expense`;
  - `an ambiguous name blocks Save until picked`;
  - `Edit opens the form pre-filled`;
  - `a reminder card shows the balance and Send posts the reminder`;
  - `already reminded today says so`;
  - `ai unavailable offers the full form`.
- [ ] **Step 1:** Failing tests. Run. Expected: FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** `corepack pnpm --filter mobile test && corepack pnpm --filter mobile typecheck && corepack pnpm --filter mobile export`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(mobile): add an expense or a reminder in one sentence`

### Task 9: End to end

- [ ] **Step 1:** Under Aspire with two local test accounts in one group:
  - "dinner R300 split with {other}" → card → Save → the expense exists, and the other gets the 3c email if enabled;
  - "tell {other} they owe me R20" → the card shows the real balance and the mismatch line → Send → a REMINDER email in Mailpit;
  - a second Send → "already reminded today".
  Without a Gemini key locally, record that the model step was faked by Ollama or skipped, and test the card with `/ai/resolve`.
- [ ] **Step 2:** Compose smoke in a throwaway project: ai healthy with the new env; `/ai/parse` without a token → 401 through Caddy.
- [ ] **Step 3:** Record the results in the ledger.
