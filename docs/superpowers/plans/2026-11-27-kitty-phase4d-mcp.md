# Kitty Phase 4d: MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ChatGPT, Claude and other MCP clients can connect to Kitty, sign in through Keycloak, read the person's groups, balances and expenses, and prepare expense, payment and reminder drafts that the person confirms in Kitty through a link.

**Architecture:** A Streamable HTTP MCP endpoint at `/mcp` in the ai service (Python, official `mcp` SDK), behind Kitty's own token check (audience `kitty-mcp`) and Protected Resource Metadata. The ai service exchanges the assistant's token at Keycloak for a ledger token and reuses Ask Kitty's lookups and 4a/4c's draft building. Drafts are stored in the ai schema for 24 hours and opened by `{web}/d/{id}` on web and Android, which show the existing confirmation cards.

**Tech Stack:** Python 3.13, FastAPI, `mcp` 2.3.0, httpx, psycopg; .NET ledger (minimal APIs, EF Core); Keycloak 26.6 realm import; Next.js web; Expo mobile; Caddy + Docker Compose.

**Spec:** `docs/superpowers/specs/2026-11-27-kitty-phase4d-mcp-design.md` (parent: `docs/superpowers/specs/2026-11-15-kitty-design.md`)

## Global Constraints

- The MCP server never writes to the ledger. Writes happen only when the person taps Save or Send in Kitty.
- Kitty runs no model for MCP calls.
- One new runtime dependency: `mcp==2.3.0` in `services/ai/pyproject.toml`. No other new dependencies (runtime or dev) without asking the owner.
- Tokens accepted at `/mcp` must have audience `kitty-mcp`. They must not carry `kitty-ledger`. The ai service never forwards an MCP token to the ledger; it exchanges it for a ledger token for the same person.
- The confidential client used for the exchange is `kitty-mcp` (the same name as the audience).
- Drafts expire after 24 hours, are deleted once saved or sent, and are returned only to the same Keycloak `sub`.
- A draft link is `{web}/d/{id}` and carries nothing else.
- Logs record the tool name, `sub` and timing. They never record arguments, descriptions or results. The httpx and httpcore loggers stay at WARNING.
- Per-person limits: reads 120 an hour, drafts 30 an hour.
- Keycloak stays at 26.6. Realm changes go in `infra/keycloak/kitty-realm.json`.
- Every person-visible string uses Kitty's money format (`R 450,00`, no-break spaces, decimal comma), pinned by `contracts/fixtures/money-format.json`.
- Conventional commits; no attribution lines in commits or PRs.

## Review Focus

1. Someone opens a draft link meant for someone else, or one that's expired or already used. Expect 404 from the ai service and "This draft has expired or was already used. Ask again in your chat." in the apps (Tasks 3, 7, 8).
2. An MCP token is sent straight to the ledger. Expect 401, because it lacks `kitty-ledger` (Task 6 check script).
3. A tool is called with a group id the person isn't in. Expect `{"error": "not_found"}` and no data (Task 5).
4. `/mcp` is called with no token, an expired token, or a `kitty-ai` token. Expect 401 with `WWW-Authenticate: Bearer resource_metadata="…"` (Task 4).
5. The `q` text contains `%` or `_`. Expect it to match literally and not act as a wildcard (Task 1).

---

### Task 1: Ledger `expense-lines` endpoint

**Files:**
- Create: `services/ledger/src/Kitty.Ledger/Features/Spending/ExpenseLineEndpoints.cs`
- Modify:
  - `services/ledger/src/Kitty.Ledger/Features/Expenses/ExpenseEndpoints.cs`: make `EncodeCursor` and `TryDecodeCursor` `internal`.
  - `services/ledger/src/Kitty.Ledger/Program.cs:136`: add `group.MapExpenseLines();` beside `group.MapSpending();`.
  - `services/ledger/openapi/ledger.json`: the committed OpenAPI document, regenerated.
  - `packages/api-client/src/schema.d.ts`: regenerated.
- Test: `services/ledger/tests/Kitty.Ledger.IntegrationTests/ExpenseLineTests.cs`

**Interfaces:**
- Produces: `GET /groups/{groupId}/expense-lines?from&to&category&q&member&cursor&limit`, returning `ExpenseLinePageDto(IReadOnlyList<ExpenseLineDto> Items, string? NextCursor)`.
  - `ExpenseLineDto` is the existing type in `Features/Common`.
  - Order is newest first, by (OccurredOn, CreatedAt, Id) descending. Paging uses the same keyset cursor as `ListExpenses`.
  - The group-member filter applies, as on every group route (non-members get 404).

- [ ] **Step 1: Write the failing tests** in `ExpenseLineTests.cs`. Use the same fixture style as `SpendingTests.cs`.
  - `Lists_newest_first_with_formatted_total_and_my_share`:
    - R 450,00 dinner on 2026-11-20, split equally with Sam.
    - R 80,00 groceries on 2026-11-22.
    - Items in order: groceries, then dinner. Dinner's `Total.Text == "R 450,00"` and `MyShare.Text == "R 225,00"`.
  - `Filters_by_dates_category_text_and_member`: each filter on its own narrows to the expected ids. `member` matches the payer or anyone with a share.
  - `Text_filter_is_literal`: `q=50%` matches "50% off pizza" and doesn't match "R50 lunch". `q=a_b` doesn't match "axb".
  - `Pages_with_the_cursor`: `limit=1` returns one item and a `NextCursor`, and the second page has the other item.
  - `Rejects_bad_arguments`: each of these returns 400:
    - `from` after `to`
    - an unknown category
    - `q` over 100 characters
    - a `member` not in the group
    - `limit=0`
  - `Hides_other_groups`: a non-member gets 404.

- [ ] **Step 2: Run them to verify they fail**
  - Run: `dotnet test --project services/ledger/tests/Kitty.Ledger.IntegrationTests -- --filter-class "*ExpenseLineTests"`
  - Expected: FAIL (404: the route doesn't exist).

- [ ] **Step 3: Implement `ExpenseLineEndpoints.MapExpenseLines(this RouteGroupBuilder group)`**
  - Validation: the same checks as `SpendingEndpoints.GetAsync`, plus the limit checks from `ListAsync` (default page size and maximum).
  - `q` is a database filter, `EF.Functions.ILike(e.Description, "%" + escaped + "%", "\\")`, with `\`, `%` and `_` escaped. It must be a database filter, unlike Spending's in-memory `Contains`, so that paging stays correct.
  - `member`: `e.Payers.Any(p => p.MemberId == m) || e.Shares.Any(s => s.MemberId == m)`.
  - Build each line with `ExpenseLineDto.Of(e, me, names)`.
  - Tag it "Spending" and name it "ListExpenseLines".

- [ ] **Step 4: Run the tests to verify they pass.** Same command. Expected: PASS.

- [ ] **Step 5: Regenerate the contract and check drift**
  - Run `dotnet test --project services/ledger/tests/Kitty.Ledger.IntegrationTests -- --filter-class "*OpenApiTests"`. It fails and says how to update the committed document; follow that.
  - Then run `pnpm --filter @kitty/api-client generate`.
  - Expected: the OpenApiTests pass, and `schema.d.ts` gains `/groups/{groupId}/expense-lines`.

- [ ] **Step 6: Run the whole ledger suite:** `dotnet test --project services/ledger/tests/Kitty.Ledger.IntegrationTests`. Expected: all pass.

- [ ] **Step 7: Commit:** `feat(ledger): expense lines with date, category, text and member filters`

---

### Task 2: ai reader, shared draft building, money text

**Files:**
- Create:
  - `services/ai/src/kitty_ai/entry/drafting.py`
  - `services/ai/src/kitty_ai/money_text.py`
- Modify:
  - `services/ai/src/kitty_ai/ledger.py`: add `expense_lines`.
  - `services/ai/src/kitty_ai/entry/routes.py`: use `drafting.draft_for` instead of the closure.
- Test:
  - `services/ai/tests/test_ledger_reader.py`
  - `services/ai/tests/test_money_text.py`
  - `services/ai/tests/test_entry_routes.py` (must stay green)

**Interfaces:**
- Produces:
  - `LedgerReader.expense_lines(group_id: str, from_: str | None, to: str | None, category: str | None, q: str | None, member: str | None, cursor: str | None, limit: int = 20) -> dict` returns the ledger's JSON. It sends only the parameters that are set, and raises `NotFound` on 404.
  - `drafting.draft_for(reader: LedgerReader, parsed: ParsedSentence, group_id: str, today: date) -> dict` is the body of today's `draft_for` closure in `entry/routes.py`. It raises `NotFound` when the person isn't a member.
  - `money_text(minor: int, currency: str) -> str` mirrors the ledger's `MoneyText.Format`.

- [ ] **Step 1: Write the failing tests**
  - `test_expense_lines_sends_only_set_filters`: the request path is `/groups/g1/expense-lines` with query `{"from": "2026-11-01", "member": "m2", "limit": "20"}`.
  - `test_expense_lines_not_found`: a 404 from the ledger raises `NotFound`.
  - `test_money_text_matches_fixture`: for every case in `contracts/fixtures/money-format.json`, `money_text(case.minor, case.currency) == case.text`. Read the fixture's shape first and loop over it.

- [ ] **Step 2: Run them to verify they fail**
  - Run: `cd services/ai && uv run pytest tests/test_ledger_reader.py tests/test_money_text.py -q`
  - Expected: FAIL (`AttributeError`, `ModuleNotFoundError`).

- [ ] **Step 3: Implement**
  - Add `expense_lines` and `money_text` (prefixes and no-break spaces as in `MoneyText.cs`; exponent from `kitty_ai.currencies.exponent`).
  - Move `draft_for` into `entry/drafting.py`, and have `make_router` call `drafting.draft_for(reader, parsed, group_id, today())`.

- [ ] **Step 4: Run the ai suite:** `cd services/ai && uv run pytest -q -m "not slow"`. Expected: all pass, including `test_entry_routes.py` unchanged.

- [ ] **Step 5: Commit:** `feat(ai): read expense lines, format money, share draft building`

---

### Task 3: Draft store and `/drafts/{id}`

**Files:**
- Create:
  - `services/ai/src/kitty_ai/mcp/__init__.py`
  - `services/ai/src/kitty_ai/mcp/drafts.py`
  - `services/ai/src/kitty_ai/mcp/draft_routes.py`
- Modify: `services/ai/src/kitty_ai/main.py`: include the router when `auth_issuer` is set.
- Test: `services/ai/tests/test_mcp_drafts.py`, plus a `@pytest.mark.slow` Postgres test in the same file (testcontainers postgres, already a dev dependency).

**Interfaces:**
- Produces:
  - `Draft(id: str, sub: str, group_id: str, parsed: ParsedSentence, created_at: datetime)`, frozen.
  - `DraftStore` protocol:
    - `save(sub, group_id, parsed) -> str`
    - `get(draft_id, sub) -> Draft | None`
    - `delete(draft_id, sub) -> None`
  - `InMemoryDraftStore(now: Callable[[], datetime])` and `PostgresDraftStore(dsn: str, now=...)`.
  - The Postgres table is `ai.mcp_drafts (id text primary key, sub text not null, group_id text not null, parsed jsonb not null, created_at timestamptz not null)`, created with `IF NOT EXISTS` on first use, like `receipts/worker.py`. Expired rows are deleted on each `save`.
  - Ids come from `secrets.token_urlsafe(16)`.
  - `DRAFT_TTL = timedelta(hours=24)`.
  - `make_draft_router(settings, verifier: TokenVerifier, store: DraftStore, http_client, today=south_african_today) -> APIRouter` serves:
    - `GET /drafts/{id}`: the same body `/resolve` returns, resolved afresh with the caller's token and the stored `parsed` and group.
    - `DELETE /drafts/{id}`: 204, idempotent.
    - Both answer 401 without a valid `kitty-ai` token, and 404 for a missing, expired or other-`sub` draft.

- [ ] **Step 1: Write the failing tests**
  - `test_get_returns_the_resolved_card`: a saved expense draft, fetched by the same `sub` through `TestClient`, returns 200 with `intent == "expense"` and the group id. The ledger is faked as in `test_entry_routes.py`.
  - `test_other_person_gets_404`: same id, different `sub`, 404.
  - `test_expired_gets_404`: `now` is 24 h + 1 s after save, 404.
  - `test_delete_then_get_404`: DELETE returns 204, then GET returns 404. A second DELETE also returns 204.
  - `test_needs_token`: no Authorization header gives 401.
  - `test_ids_are_unguessable`: two saves give different ids of at least 22 characters.
  - `test_postgres_store_round_trip` (slow): save, get, a get for another sub returns None, a get after expiry returns None.

- [ ] **Step 2: Run them to verify they fail**
  - Run: `cd services/ai && uv run pytest tests/test_mcp_drafts.py -q -m "not slow"`
  - Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Implement** `drafts.py` and `draft_routes.py`. In `main.py`, build `PostgresDraftStore(settings.postgres_dsn)` when the DSN is set, else `InMemoryDraftStore`, and include `make_draft_router`.

- [ ] **Step 4: Run the tests to verify they pass:** `cd services/ai && uv run pytest tests/test_mcp_drafts.py -q`. Expected: PASS, including the slow Postgres test (Docker must be running).

- [ ] **Step 5: Commit:** `feat(ai): drafts that only their owner can open, for 24 hours`

---

### Task 4: MCP sign-in: metadata, token check, token exchange

**Files:**
- Create:
  - `services/ai/src/kitty_ai/mcp/auth.py`
  - `services/ai/src/kitty_ai/mcp/metadata.py`
- Modify: `services/ai/src/kitty_ai/settings.py`
- Test: `services/ai/tests/test_mcp_auth.py`

**Interfaces:**
- Produces:
  - New `Settings` fields:
    - `mcp_public_url: str = ""` (MCP is off when it's empty; locally `http://localhost:5085/mcp`, deployed `https://{host}/ai/mcp`)
    - `mcp_audience: str = "kitty-mcp"`
    - `mcp_client_secret: str = ""`
    - `web_url: str = ""` (base of draft links)
  - `metadata.protected_resource(settings) -> dict`:

    ```python
    {"resource": mcp_public_url, "authorization_servers": [auth_issuer], "scopes_supported": ["kitty-mcp"],
     "bearer_methods_supported": ["header"], "resource_name": "Kitty"}
    ```

  - `metadata.metadata_url(settings) -> str`: the URL origin, plus `/.well-known/oauth-protected-resource`, plus the URL path. For example, `https://h/ai/mcp` gives `https://h/.well-known/oauth-protected-resource/ai/mcp`.
  - `metadata.make_metadata_router(settings) -> APIRouter` serves the dict at `/.well-known/oauth-protected-resource` and at `/.well-known/oauth-protected-resource/{rest:path}`.
  - `auth.CURRENT: ContextVar[McpCaller]`, where `McpCaller(sub: str, ledger_token: str)`.
  - `auth.LedgerTokenExchanger(token_url: str, client_id: str, client_secret: str, http: httpx.Client, now=time.monotonic)` with `.exchange(subject_token: str) -> str`.
    - It posts the RFC 8693 form: `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token`, `subject_token_type=urn:ietf:params:oauth:token-type:access_token`, `requested_token_type` (the same type), `audience=kitty-ledger`, and the client's credentials.
    - It caches by the SHA-256 of the subject token until 30 s before `expires_in`.
    - It raises `Unauthorized` on 4xx.
  - `auth.McpAuth(app: ASGIApp, verifier: TokenVerifier, exchanger: LedgerTokenExchanger, metadata_url: str)` is ASGI middleware.
    - On a verified token (audience `kitty-mcp`), it sets `CURRENT` for the request and calls `app`.
    - Otherwise it answers 401 with JSON `{"code":"unauthorized"}` and the header `WWW-Authenticate: Bearer resource_metadata="{metadata_url}", scope="kitty-mcp"`.

- [ ] **Step 1: Write the failing tests** (use `tests.tokens.TestIssuer`, and fake Keycloak with `httpx.MockTransport`).
  - `test_metadata_shape_and_paths`: both paths return the dict above for `mcp_public_url="https://h/ai/mcp"`, `auth_issuer="https://h/auth/realms/kitty"`.
  - `test_metadata_url_appends_the_path`: as in the example above.
  - `test_no_token_401_with_resource_metadata`
  - `test_wrong_audience_401`: a `kitty-ai` token is refused.
  - `test_expired_401`
  - `test_valid_token_sets_caller_with_exchanged_token`: the inner app sees `CURRENT.get() == McpCaller(sub, "ledger-token")`, and the posted form has `audience=kitty-ledger` and the subject token.
  - `test_exchange_is_cached_until_near_expiry`: two calls make one request. After `expires_in - 29` seconds a call makes a second request.
  - `test_exchange_refused_is_401`: Keycloak answering 400 makes the middleware answer 401.

- [ ] **Step 2: Run them to verify they fail**
  - Run: `cd services/ai && uv run pytest tests/test_mcp_auth.py -q`
  - Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Implement** `auth.py` and `metadata.py`. The token URL is `{auth_issuer}/protocol/openid-connect/token`. Reuse `TokenVerifier` with `settings.mcp_audience`.

- [ ] **Step 4: Run the tests to verify they pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit:** `feat(ai): MCP sign-in with resource metadata and ledger token exchange`

---

### Task 5: MCP tools and server

**Files:**
- Create:
  - `services/ai/src/kitty_ai/mcp/tools.py`: pure functions, no SDK.
  - `services/ai/src/kitty_ai/mcp/summary.py`
  - `services/ai/src/kitty_ai/mcp/server.py`: SDK wiring.
- Modify:
  - `services/ai/pyproject.toml`: add `mcp==2.3.0`, then run `uv lock`.
  - `services/ai/src/kitty_ai/main.py`: mount when `mcp_public_url` is set.
- Test:
  - `services/ai/tests/test_mcp_tools.py`
  - `services/ai/tests/test_mcp_summary.py`
  - `services/ai/tests/test_mcp_server.py`

**Interfaces:**
- Consumes:
  - `LedgerReader` (`groups`, `group`, `owing`, `spending`, `expense_lines`) and `drafting.draft_for` (Task 2)
  - `DraftStore.save` (Task 3)
  - `McpCaller` and `CURRENT` (Task 4)
  - `match_group` from `entry/resolve.py`
- Produces (in `tools.py`). Each function takes `(reader: LedgerReader, args: dict)` and returns a JSON-able dict.
  - `list_groups`: `{"groups": [{"id","name","currency","members": [{"name","hasAccount"}]}]}`.
  - `get_balances`:
    - With no `group`: `reader.owing()`.
    - With a group: `{"group": …, "balances": <ledger /groups/{id}/balances>}`. Add a `balances(group_id)` reader method in this task.
  - `group_spending`: Ask's argument rules (reuse `ask.tools._spending_args`, renamed public as `spending_args`), then `reader.spending`.
  - `list_expenses`: `group` (required), `from`, `to`, `category`, `text`, `person` (a member name, matched with `match_member`), `cursor`. Calls `reader.expense_lines` with `limit=20`.
  - `draft(reader, store, sub, web_url, intent, args, today) -> dict` maps `args` onto `ParsedSentence`:
    - `intent` is `"expense"`, `"payment"` or `"reminder"`.
    - Expense args: `group`, `description`, `amount`, `currency`, `payer`, `people[{name, amount}]`, `split`, `date`, `category`.
    - Payment args: `group`, `direction`, `counterpart`, `items`, `amount`, `date`.
    - Reminder args: `group`, `person` (becomes `people=[{name: person}]`), `for` (becomes `description`), `amount` (becomes `reminder_amount`).
    - It runs `match_group(args["group"], None, reader.groups())`.
    - **No group match:** `{"draft": None, "issues": [the group issue], "groups": [{"id","name"}…]}`, and nothing is stored.
    - **Otherwise:** it builds with `draft_for`, stores it, and returns `{"summary": summary.of(draft), "link": f"{web_url}/d/{id}", "issues": draft["issues"]}`.
  - Errors are results, never exceptions: `NotFound` gives `{"error": "not_found"}`, a ledger 400 gives `{"error": "bad_arguments"}`, and bad arguments give `{"error": "bad_arguments", "detail": "<field>"}`.
- Produces (in `summary.py`): `summary.of(draft: dict) -> str` builds one plain sentence from the draft dict using `money_text`, for example:
  - `"Expense in Flat 4B: Dinner, R 450,00, paid by you, split equally between you, Sam and Ana. Open the link to check and save it."`
  - `"Payment in Flat 4B: you pay Bob R 50,00 for Uber. Open the link to check and save it."`
  - `"Reminder in Flat 4B: remind Bob he owes you R 20,00. Open the link to check and send it."`
  - Names come from the draft's `members`. "You" stands for the caller's member. Any issue appends `" Kitty needs you to settle: <n> thing(s) on the card."`
- Produces (in `server.py`): `build_mcp(settings, reader_for: Callable[[McpCaller], LedgerReader], store, limits) -> ASGIApp`.
  - It uses the SDK's `MCPServer("Kitty")` with seven tools: `list_groups`, `get_balances`, `group_spending`, `list_expenses`, `draft_expense`, `draft_payment`, `draft_reminder`.
  - Each tool's description says what it does and when to use it. The draft descriptions say "Nothing is saved: give the person the link to check and save it in Kitty."
  - Read tools carry `readOnlyHint=True`. Draft tools carry `readOnlyHint=False, destructiveHint=False`.
  - Tool functions read `CURRENT.get()` and call `tools.*`.
  - It uses the SDK's Streamable HTTP ASGI app, stateless with JSON responses if the SDK offers them (check `mcp` 2.3.0's docs for `MCPServer` HTTP options), wrapped in `McpAuth`.
- In `main.py`, mount the result at `/mcp` and include `make_metadata_router`.
- Limits use `RateLimiter(120, 3600)` for reads and `RateLimiter(30, 3600)` for drafts, keyed by `sub`. Over the limit, a tool returns `{"error": "rate_limited"}`.
- Each call logs `mcp tool=%s sub=%s ms=%d` at INFO.

- [ ] **Step 1: Write the failing tests**
  - `test_mcp_tools.py` (fake ledger as in `test_ask_routes.py`, `InMemoryDraftStore`):
    - `test_list_groups_has_members`
    - `test_get_balances_all_and_one_group`
    - `test_list_expenses_maps_person_to_member_id` (an unknown person gives `bad_arguments` with detail `person`)
    - `test_other_group_is_not_found`
    - `test_draft_expense_stores_and_links`: the link starts with `http://localhost:3000/d/`, and `store.get(id, sub)` returns the draft.
    - `test_draft_with_unknown_group_returns_groups_and_no_link`
    - `test_draft_with_issue_still_links`: an unknown person "Sem" gives a link, and the issues contain `people[0]` `no_match`.
    - `test_draft_payment_and_reminder_shapes`
  - `test_mcp_summary.py`: the three example sentences above, exactly, from hand-built draft dicts; plus the issue suffix.
  - `test_mcp_server.py` (in-process, `TestClient(create_app(settings))` with a `kitty-mcp` token from `TestIssuer` and a faked exchanger):
    - `test_tools_list_names_and_hints`: posts the MCP `initialize` and `tools/list` JSON-RPC requests (with the headers the SDK requires) and gets the seven names, with the hints above.
    - `test_tools_call_list_groups`
    - `test_no_token_is_401`
    - `test_rate_limited_draft`: the 31st draft returns `rate_limited`.
    - `test_logs_have_no_arguments`: caplog contains `tool=draft_expense` and doesn't contain the description "Dinner".

- [ ] **Step 2: Run them to verify they fail**
  - Run: `cd services/ai && uv run pytest tests/test_mcp_tools.py tests/test_mcp_summary.py tests/test_mcp_server.py -q`
  - Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Add the dependency:** `cd services/ai && uv add mcp==2.3.0`. Expected: `pyproject.toml` and `uv.lock` change, and nothing else is added at the top level.

- [ ] **Step 4: Implement** `tools.py`, `summary.py`, `server.py` and the mount.

- [ ] **Step 5: Run the ai suite:** `cd services/ai && uv run pytest -q -m "not slow" && uv run ruff check . && uv run ruff format --check .`. Expected: all pass.

- [ ] **Step 6: Commit:** `feat(ai): MCP server with read tools and confirm-in-Kitty drafts`

---

### Task 6: Keycloak realm and Aspire wiring, checked against the live stack

**Files:**
- Modify:
  - `infra/keycloak/kitty-realm.json`
  - `aspire/Kitty.AppHost/AppHost.cs`
- Create: `services/ai/scripts/check_mcp_auth.py` (httpx only, run by hand against the local stack)

**Interfaces:**
- Produces (realm):
  - A client scope `kitty-mcp` (openid-connect, included in the token) with an audience mapper adding `kitty-mcp`. It's added to `defaultOptionalClientScopes`.
  - A confidential client `kitty-mcp`:
    - secret `${KITTY_MCP_CLIENT_SECRET:dev-only-kitty-mcp-secret}`
    - no standard or direct flows, service accounts off
    - attribute `standard.token.exchange.enabled = "true"`
    - an audience mapper adding `kitty-ledger`
  - Anonymous client-registration policies:
    - trusted hosts `localhost`, `127.0.0.1`, `chatgpt.com`, `claude.ai`, `claude.com`, with "host sending the request must match" off and "client URIs must match" on
    - consent required
    - allowed client scopes limited to `kitty-mcp` and the realm's default OIDC scopes
    - at most 200 clients
- Produces (AppHost): the ai service gets these environment variables:
  - `AI_MCP_PUBLIC_URL=http://localhost:5085/mcp`
  - `AI_MCP_CLIENT_SECRET=dev-only-kitty-mcp-secret`
  - `AI_WEB_URL=http://localhost:3000`

- [ ] **Step 1: Write the check script** `check_mcp_auth.py <alice-email> <alice-password>`. Credentials are read from argv and never printed. It prints one line per check, and exits 1 on any FAIL.
  1. `GET http://localhost:5085/mcp` without a token returns 401, and the `WWW-Authenticate` header contains `resource_metadata="http://localhost:5085/.well-known/oauth-protected-resource/mcp"`.
  2. That metadata lists `http://localhost:8180/realms/kitty`.
  3. Anonymous DCR at `/realms/kitty/clients-registrations/openid-connect` with redirect `http://localhost:33418/callback` (public client, `token_endpoint_auth_method=none`) returns 201.
  4. The same with redirect `https://evil.example/cb` is refused.
  5. A PKCE login as Alice with `scope=openid kitty-mcp` and the registered client gives a token whose `aud` contains `kitty-mcp` and not `kitty-ledger`. Copy the login flow from the 4c e2e `token_for`: it submits Keycloak's login form, and the consent form when shown.
  6. That token sent to `GET http://localhost:5080/groups` returns 401.
  7. `initialize` then `tools/call list_groups` at `/mcp` with that token returns Alice's groups.

- [ ] **Step 2: Run it to verify it fails** against the running stack (restart it so the realm re-imports; recreate Alice with `register_local.py` and `verify_local.py`).
  - Run: `cd services/ai && uv run python scripts/check_mcp_auth.py <email> <password>`
  - Expected: check 1 fails, because MCP is off without the AppHost settings.

- [ ] **Step 3: Implement** the realm changes and the AppHost settings, then restart the stack.

- [ ] **Step 4: Run the check again.** Expected: seven `PASS` lines.
  - If DCR policies or token exchange behave differently on 26.6, change the realm, not the checks.
  - Record what was needed in the ledger as a ruling.

- [ ] **Step 5: Commit:** `feat(infra): Keycloak client registration and token exchange for MCP`

---

### Task 7: Web `/d/{id}`

**Files:**
- Create: `apps/web/src/app/d/[id]/page.tsx`
- Modify:
  - `apps/web/src/lib/ai.ts`
  - `apps/web/src/app/plain-entry/actions.ts`
  - `apps/web/src/components/PlainEntry.tsx`
- Test: `apps/web/test/draft-link.test.ts`

**Interfaces:**
- Consumes: ai `GET /drafts/{id}` and `DELETE /drafts/{id}` (Task 3).
- Produces:
  - In `lib/ai.ts`:
    - `getDraft(id: string): Promise<AiResult>`. A 404 maps to error `"draft_gone"`.
    - `finishDraft(id: string): Promise<void>`. It ignores errors.
  - A server action `finishDraftAction(id: string)`.
  - `PlainEntry` gains an optional prop `initial?: { draft: PlainDraft; draftId: string }`.
    - The first turn is that draft.
    - After a successful Save, payment or Send, it calls `finishDraftAction(draftId)`.
  - The page `/d/[id]`:
    - It requires sign-in, the same way other signed-in pages do (find how `groups/page.tsx` does it).
    - It checks the id's shape (`[A-Za-z0-9_-]{16,64}`, otherwise `notFound()`).
    - It renders `PlainEntry` with `initial`.
    - On `draft_gone` it shows "This draft has expired or was already used. Ask again in your chat."

- [ ] **Step 1: Write the failing tests** for `getDraft` and `finishDraft`, with `fetch` stubbed as in `ask.test.ts`:
  - 200 returns `{ draft }`.
  - 404 returns `{ error: "draft_gone" }`.
  - No `AI_URL` returns `{ error: "ai_unavailable" }`.
  - `finishDraft` sends DELETE with the bearer token.

- [ ] **Step 2: Run them to verify they fail**
  - Run: `pnpm --filter web test -- draft-link`
  - Expected: FAIL (not exported).

- [ ] **Step 3: Implement** `lib/ai.ts`, the action, the `PlainEntry` prop and the page.

- [ ] **Step 4: Run the tests and typecheck:** `pnpm --filter web test && pnpm --filter web typecheck`. Expected: pass.

- [ ] **Step 5: Commit:** `feat(web): open an assistant's draft from its link`

---

### Task 8: Android `/d/{id}`

**Files:**
- Create: `apps/mobile/src/app/(app)/d/[id].tsx`
- Modify:
  - `apps/mobile/src/ai.tsx`
  - `apps/mobile/src/components/PlainEntry.tsx`
  - `apps/mobile/app.config.ts`: add `"/d/"` to the App Link prefixes.
- Test: `apps/mobile/test/draft-link.test.tsx`

**Interfaces:**
- Produces:
  - `AiClient` gains `draft(id: string): Promise<AiResult>` (404 maps to `"draft_gone"`) and `finishDraft(id: string): Promise<void>`.
  - `PlainEntry` gains `initial?: { draft: PlainDraft; draftId: string }`, with the same behaviour as on web.
  - The screen shows the card, or the "expired or already used" sentence above.

- [ ] **Step 1: Write the failing tests** (the test client pattern from `plain-entry.test.tsx`):
  - `opens_the_card_from_the_link`: the card shows the draft's description.
  - `shows_expired_message_on_draft_gone`
  - `finishes_the_draft_after_save`: `finishDraft` is called with the id.

- [ ] **Step 2: Run them to verify they fail**
  - Run: `pnpm --filter mobile test -- draft-link`
  - Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests and typecheck:** `pnpm --filter mobile test && pnpm --filter mobile typecheck`. Expected: pass.

- [ ] **Step 5: Commit:** `feat(mobile): open an assistant's draft from its link`

---

### Task 9: Interim deploy wiring

**Files:**
- Modify:
  - `deploy/compose/Caddyfile`
  - `deploy/compose/docker-compose.yml`
  - `deploy/compose/.env.example`
  - `deploy/compose/RUNBOOK.md`
  - `deploy/compose/smoke.sh`

**Interfaces:**
- Produces:
  - Caddy: `handle /.well-known/oauth-protected-resource/*` goes to `reverse_proxy ai:8000` with the path kept. It sits before the web catch-all.
  - Compose `ai` environment:
    - `AI_MCP_PUBLIC_URL: https://${KITTY_HOST}/ai/mcp`
    - `AI_MCP_CLIENT_SECRET: ${KITTY_MCP_CLIENT_SECRET}`
    - `AI_WEB_URL: https://${KITTY_HOST}`
  - Compose `keycloak` gets `KITTY_MCP_CLIENT_SECRET`, so the realm import substitutes it.
  - `.env.example` documents `KITTY_MCP_CLIENT_SECRET=`.
  - The RUNBOOK gains a section "MCP (phase 4d)". It covers:
    - generating the secret
    - for a realm imported before 4d: the admin-console steps to add the client scope, the client and the registration policies, matching the realm file
    - checking discovery with `curl -i https://$KITTY_HOST/ai/mcp` (expect 401 and the metadata URL) and `curl https://$KITTY_HOST/.well-known/oauth-protected-resource/ai/mcp`
  - `smoke.sh` gains those two checks.

- [ ] **Step 1: Validate the config**
  - Run: `docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/trial.env.local config -q && docker run --rm -v "$PWD/deploy/compose:/etc/caddy" caddy:2 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`
  - Expected: no errors. If `trial.env.local` lacks the new variable, add it with a dummy value.

- [ ] **Step 2: Commit:** `feat(deploy): route MCP discovery and pass the MCP settings`

---

### Task 10: End to end with a real MCP client, docs

**Files:**
- Modify:
  - `docs/superpowers/specs/2026-11-15-kitty-design.md`: in the phase list, 4d is shipped as designed in `2026-11-27-kitty-phase4d-mcp-design.md`.
  - `services/ai/README.md`: an "MCP" section covering:
    - the address
    - `claude mcp add --transport http kitty http://localhost:5085/mcp`
    - the tools
    - that drafts are confirmed in Kitty

- [ ] **Step 1: Check with a real client against the running stack.**
  - Use the MCP Inspector (`npx @modelcontextprotocol/inspector`, run on the fly, nothing installed in the repo). Connect to `http://localhost:5085/mcp`, sign in as Bob, and do the following:
    - list tools (seven)
    - `list_groups`
    - `draft_expense` with group "Payment card check", "Dinner", 450, people Alice
  - Open the returned link in the browser as Bob.
    - Expected: the card shows Dinner R 450,00. Save records it, and the link then says it was already used.
  - Opening the link as Alice shows "expired or already used".

- [ ] **Step 2: Run every suite**
  - `cd services/ai && uv run pytest -q`
  - `dotnet test --project services/ledger/tests/Kitty.Ledger.IntegrationTests`
  - `pnpm --filter web test`
  - `pnpm --filter mobile test`
  - Expected: all pass.

- [ ] **Step 3: Commit:** `docs: MCP server usage and phase 4d status`
