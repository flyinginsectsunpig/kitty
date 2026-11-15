# Kitty Phase 1 — Core Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A usable, deployed Kitty: sign in, create groups, add people (including placeholders), add expenses with equal/exact/percent/shares splits, see balances with simplified debts, settle up — on the web, reachable by friends at R0/month.

**Architecture:** .NET 10 ledger API (minimal APIs, EF Core, Postgres) is the source of truth; Keycloak issues OIDC tokens; a Next.js web app talks to the ledger server-side through a client generated from the ledger's OpenAPI document. .NET Aspire runs everything locally; Docker Compose + Caddy runs it on the Oracle Always Free VM.

**Tech Stack:** .NET 10 LTS, ASP.NET Core minimal APIs, EF Core + Npgsql, xUnit, FsCheck, Testcontainers, .NET Aspire, Keycloak 26, Next.js (App Router) + TypeScript strict, Auth.js v5, Tailwind CSS, openapi-typescript + openapi-fetch, Vitest, pnpm workspaces, Docker (multi-arch), Caddy, DuckDNS, GitHub Actions, GHCR.

**Spec:** `docs/superpowers/specs/2026-11-15-kitty-design.md` (phase 1 = §9 item 1; money rules §5.3; members §5.2a).

## Global Constraints

- Money is `long` minor units + ISO 4217 code. No `float`/`double`/`decimal` (C#) or non-integer `number` (TS) anywhere in the money path. Percent splits are basis points (10000 = 100%).
- Supported currencies and their minor-unit exponents come from one file, `contracts/currencies.json`, read by both C# and TS.
- Remainder rule: after flooring, leftover minor units go +1 each to participants in **member order** = ascending ordinal comparison of `memberId.ToString("D")` lowercase (TS: same string compare). Fixtures in `contracts/fixtures/splits.json` are run by both languages.
- Every POST/PUT/PATCH/DELETE on the ledger requires an `Idempotency-Key` header (1–255 chars); responses are replayed for 24 h.
- A caller who is not a member of a group gets **404** on every `/groups/{groupId}/...` route (never 403).
- Splits and balances reference **members**, never users. A member's `userId` may be null (placeholder).
- Balances are recomputed from non-deleted expenses and settlements on every read; never stored.
- Deletes are soft (`DeletedAt`); every create/update/delete writes an `AuditEntry` in the same transaction.
- Errors are RFC 7807 ProblemDetails with a `code` extension from the table in Task 7.
- No secrets in source. `.env` files are gitignored; `.env.example` lists every variable.
- Container images are built for `linux/amd64` and `linux/arm64` (Oracle A1 is ARM).
- Conventional commits (`feat:`, `fix:`, `chore:`, `test:`, `ci:`, `docs:`). Red-green TDD.
- Versions: latest stable at build time for every package; .NET 10 LTS; Node 24 LTS.

## Review Focus

1. **Two people edit the same expense at once** → the second save gets 409 `version_conflict`, never a silent overwrite. (Task 9, test `Put_with_stale_version_returns_409`.)
2. **Invite reused or accepted by someone already in the group** → 409 `invite_used` / `already_member`, and the placeholder is never claimed twice. (Task 8, tests `Accept_used_invite_returns_409`, `Accept_when_already_member_returns_409`.)
3. **Uneven and zero-decimal amounts** → R100.00 split 3 ways is 3334/3333/3333 in member order; ¥1000 split 3 ways is 334/333/333 and formats as "¥334". (Tasks 2/3/11 via shared fixtures.)
4. **Keycloak access token (5 min) expires mid-session** → the web app refreshes silently; a failed refresh sends the user to sign-in instead of showing errors. (Task 12, `refreshAccessToken` tests.)
5. **Payer/participant from a different group, or a guessed group id** → 400 `member_not_in_group` / 404. (Task 9 `Create_with_foreign_member_returns_400`; Task 8 `Non_member_gets_404`.)

---

## File Structure

```
.gitignore  .editorconfig  global.json  Kitty.slnx
Directory.Build.props  Directory.Packages.props
package.json  pnpm-workspace.yaml  README.md
contracts/currencies.json
contracts/fixtures/splits.json
aspire/Kitty.AppHost/AppHost.cs
aspire/Kitty.ServiceDefaults/Extensions.cs
infra/keycloak/kitty-realm.json
services/ledger/src/Kitty.Ledger/
  Program.cs
  Domain/Money.cs  Domain/Currencies.cs  Domain/MemberOrder.cs
  Domain/Splits/SplitCalculator.cs  Domain/Splits/SplitModels.cs
  Domain/Balances/BalanceCalculator.cs  Domain/Balances/DebtSimplifier.cs
  Data/LedgerDbContext.cs  Data/Entities/*.cs  Data/Migrations/*
  Infrastructure/Auth/CurrentUser.cs  Infrastructure/Auth/AuthSetup.cs
  Infrastructure/Idempotency/IdempotencyFilter.cs  Infrastructure/Idempotency/IdempotencyCleanup.cs
  Infrastructure/Errors/ApiError.cs  Infrastructure/Audit/AuditWriter.cs
  Features/Me/MeEndpoints.cs
  Features/Groups/GroupEndpoints.cs  Features/Groups/GroupMemberFilter.cs
  Features/Members/MemberEndpoints.cs  Features/Invites/InviteEndpoints.cs
  Features/Expenses/ExpenseEndpoints.cs  Features/Expenses/ExpenseDtos.cs  Features/Expenses/ExpenseValidator.cs
  Features/Settlements/SettlementEndpoints.cs
  Features/Balances/BalanceEndpoints.cs  Features/Activity/ActivityEndpoints.cs
  Dockerfile
services/ledger/tests/Kitty.Ledger.UnitTests/
services/ledger/tests/Kitty.Ledger.IntegrationTests/
  LedgerApiFactory.cs  TestTokens.cs  ApiClientExtensions.cs  *Tests.cs
packages/money/src/{currencies.ts,format.ts,parse.ts,split.ts,index.ts}  packages/money/test/*.test.ts
packages/api-client/src/{schema.d.ts,index.ts}  packages/api-client/scripts/generate.mjs
apps/web/  (Next.js; src/auth/*, src/lib/ledger.ts, src/app/**)
apps/web/Dockerfile
deploy/compose/{docker-compose.yml,Caddyfile,.env.example,smoke.sh,RUNBOOK.md}
.github/workflows/{ledger.yml,web.yml,images.yml}
```

---

### Task 1: Repository scaffold

**Files:**
- Create: `.gitignore`, `.editorconfig`, `global.json`, `Kitty.slnx`, `Directory.Build.props`, `Directory.Packages.props`, `package.json`, `pnpm-workspace.yaml`, `README.md`

**Interfaces:**
- Produces: solution at repo root; central package management (`ManagePackageVersionsCentrally=true`); `Directory.Build.props` sets `Nullable=enable`, `TreatWarningsAsErrors=true`, `ImplicitUsings=enable`, `LangVersion=latest`; pnpm workspace globs `apps/*`, `packages/*`.

- [ ] **Step 1:** `git init -b main`. `.gitignore` covers `bin/ obj/ node_modules/ .next/ .env *.env.local coverage/ TestResults/`.
- [ ] **Step 2:** `global.json` pins the installed .NET 10 SDK with `rollForward: latestFeature`. Root `package.json` has `"packageManager": "pnpm@<current>"`, `"engines": {"node": ">=24"}`.
- [ ] **Step 3:** Verify: `dotnet --version` prints 10.x; `pnpm install` succeeds with an empty workspace.
- [ ] **Step 4:** README stub: one paragraph from spec §1 plus "Local dev: `dotnet run --project aspire/Kitty.AppHost`".
- [ ] **Step 5:** Commit `chore: scaffold monorepo`.

---

### Task 2: Money and currencies (C#)

**Files:**
- Create: `contracts/currencies.json`, `services/ledger/src/Kitty.Ledger/Kitty.Ledger.csproj` (web SDK), `Domain/Money.cs`, `Domain/Currencies.cs`, `Domain/MemberOrder.cs`
- Test: `services/ledger/tests/Kitty.Ledger.UnitTests/MoneyTests.cs`

**Interfaces:**
- Produces:
  - `contracts/currencies.json`: `{ "ZAR": 2, "USD": 2, "EUR": 2, "GBP": 2, "JPY": 0, ... }` — exactly the currencies the Frankfurter API supports, with ISO 4217 exponents. Embedded into the ledger assembly as a resource.
  - `static class Currencies { bool IsSupported(string code); int Exponent(string code); }`
  - `readonly record struct Money(long Minor, string Currency)`; ctor throws `ArgumentException` for unsupported currency; `operator +`/`-` throw `InvalidOperationException` on currency mismatch.
  - `static class MemberOrder { int Compare(Guid a, Guid b); IReadOnlyList<Guid> Sort(IEnumerable<Guid> ids); }` — ordinal compare of lowercase `"D"` strings.

- [ ] **Step 1: Write failing tests**

```csharp
[Fact] public void Unsupported_currency_throws() => Assert.Throws<ArgumentException>(() => new Money(100, "XXX"));
[Fact] public void Adding_different_currencies_throws() =>
    Assert.Throws<InvalidOperationException>(() => new Money(1, "ZAR") + new Money(1, "USD"));
[Fact] public void Jpy_has_zero_exponent() => Assert.Equal(0, Currencies.Exponent("JPY"));
[Fact] public void Zar_has_two_exponent() => Assert.Equal(2, Currencies.Exponent("ZAR"));
[Fact] public void MemberOrder_is_ordinal_on_lowercase_D_string()
{
    var a = Guid.Parse("0000000a-0000-0000-0000-000000000000");
    var b = Guid.Parse("00000001-0000-0000-0000-000000000000");
    Assert.Equal(new[] { b, a }, MemberOrder.Sort(new[] { a, b }));
}
```

- [ ] **Step 2:** Run `dotnet test services/ledger/tests/Kitty.Ledger.UnitTests` → FAIL (types missing).
- [ ] **Step 3:** Implement the four types above.
- [ ] **Step 4:** Run tests → PASS.
- [ ] **Step 5:** Commit `feat(ledger): money and currency primitives`.

---

### Task 3: Split calculator

**Files:**
- Create: `Domain/Splits/SplitModels.cs`, `Domain/Splits/SplitCalculator.cs`, `contracts/fixtures/splits.json`
- Test: `UnitTests/SplitCalculatorTests.cs`, `UnitTests/SplitFixtureTests.cs`

**Interfaces:**
- Produces:
  - `enum SplitMethod { Equal, Exact, Percent, Shares }`
  - `record SplitInput(Guid MemberId, long? Value)` — Equal: null; Exact: minor units; Percent: basis points; Shares: weight 1–1000.
  - `record Share(Guid MemberId, long Minor)`
  - `static SplitResult SplitCalculator.Calculate(long totalMinor, SplitMethod method, IReadOnlyList<SplitInput> participants)` where `SplitResult` is either `Ok(IReadOnlyList<Share>)` (ordered by member order) or `Error(string Code)` with codes `split_empty`, `split_duplicate_member`, `split_sum_mismatch`, `split_invalid_value`.
  - Fixture format: `[{ "name", "totalMinor", "method", "participants":[{"memberId","value"}], "expected":[{"memberId","minor"}] | null, "error": "code" | null }]`.

- [ ] **Step 1: Write failing tests**

```csharp
static readonly Guid A = Guid.Parse("00000001-0000-0000-0000-000000000000"),
                     B = Guid.Parse("00000002-0000-0000-0000-000000000000"),
                     C = Guid.Parse("00000003-0000-0000-0000-000000000000");

[Fact] public void Equal_three_way_gives_remainder_in_member_order()
{
    var r = Ok(SplitCalculator.Calculate(10000, SplitMethod.Equal, [new(C, null), new(A, null), new(B, null)]));
    Assert.Equal(new[] { new Share(A, 3334), new Share(B, 3333), new Share(C, 3333) }, r);
}
[Fact] public void Exact_must_sum_to_total() =>
    AssertError("split_sum_mismatch", SplitCalculator.Calculate(1000, SplitMethod.Exact, [new(A, 400), new(B, 500)]));
[Fact] public void Percent_must_sum_to_10000_bp() =>
    AssertError("split_sum_mismatch", SplitCalculator.Calculate(1000, SplitMethod.Percent, [new(A, 5000), new(B, 4000)]));
[Fact] public void Percent_floors_then_distributes_remainder() // 1001 * 1/3 each
{
    var r = Ok(SplitCalculator.Calculate(1001, SplitMethod.Percent, [new(A, 3334), new(B, 3333), new(C, 3333)]));
    Assert.Equal(1001, r.Sum(s => s.Minor));
}
[Fact] public void Shares_weight_2_1() =>
    Assert.Equal(new[] { new Share(A, 667), new Share(B, 333) },
        Ok(SplitCalculator.Calculate(1000, SplitMethod.Shares, [new(A, 2), new(B, 1)])));
[Fact] public void Zero_or_negative_values_rejected() =>
    AssertError("split_invalid_value", SplitCalculator.Calculate(1000, SplitMethod.Shares, [new(A, 0), new(B, 1)]));
[Fact] public void Duplicate_member_rejected() =>
    AssertError("split_duplicate_member", SplitCalculator.Calculate(1000, SplitMethod.Equal, [new(A, null), new(A, null)]));

// FsCheck property
[Property] public bool Shares_always_sum_to_total(PositiveInt total, NonEmptyArray<PositiveInt> weights) { /* build Shares split with weights clamped 1..1000; assert sum == total */ }

// Fixture runner
[Fact] public void All_shared_fixtures_pass() { /* load contracts/fixtures/splits.json; assert each expected/error */ }
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Algorithm (all methods): compute floored base shares, then add the leftover:

```csharp
// base_i: Equal = total / n; Percent = total * bp_i / 10000; Shares = total * w_i / Σw  (checked long; total ≤ 10_000_000_000)
var ordered = MemberOrder.Sort(ids);
long leftover = total - baseShares.Sum();
for (int i = 0; leftover > 0; i++, leftover--) shares[ordered[i % ordered.Count]] += 1;
// Exact: no rounding; validate Σ == total.
```

- [ ] **Step 4:** Write `contracts/fixtures/splits.json` with at least: the three-way R100 case, ¥1000 three-way (334/333/333), shares 2:1, percent remainder, each error code. Run tests → PASS.
- [ ] **Step 5:** Commit `feat(ledger): deterministic split calculator with shared fixtures`.

---

### Task 4: Balances and debt simplification

**Files:**
- Create: `Domain/Balances/BalanceCalculator.cs`, `Domain/Balances/DebtSimplifier.cs`
- Test: `UnitTests/BalanceCalculatorTests.cs`, `UnitTests/DebtSimplifierTests.cs`

**Interfaces:**
- Consumes: `Share`, `MemberOrder` (Tasks 2–3).
- Produces:
  - `record LedgerExpense(string Currency, IReadOnlyList<Share> Payers, IReadOnlyList<Share> Shares)`
  - `record LedgerSettlement(string Currency, Guid From, Guid To, long Minor)`
  - `static IReadOnlyDictionary<string, IReadOnlyDictionary<Guid, long>> BalanceCalculator.NetByCurrency(IEnumerable<LedgerExpense>, IEnumerable<LedgerSettlement>)` — positive = is owed. Payer +paid, participant −share; settlement From +minor, To −minor.
  - `record Transfer(Guid From, Guid To, long Minor)`
  - `static IReadOnlyList<Transfer> DebtSimplifier.Simplify(IReadOnlyDictionary<Guid, long> nets)` — throws `ArgumentException` if Σ≠0.

- [ ] **Step 1: Write failing tests**

```csharp
[Fact] public void Payer_is_owed_others_share()
{ // A pays 900 split equally A,B,C
    var n = BalanceCalculator.NetByCurrency([new("ZAR", [new(A, 900)], [new(A, 300), new(B, 300), new(C, 300)])], [])["ZAR"];
    Assert.Equal(600, n[A]); Assert.Equal(-300, n[B]); Assert.Equal(-300, n[C]);
}
[Fact] public void Settlement_reduces_debt()
{
    var n = BalanceCalculator.NetByCurrency([new("ZAR", [new(A, 900)], [new(A, 300), new(B, 300), new(C, 300)])],
                                            [new("ZAR", B, A, 300)])["ZAR"];
    Assert.Equal(0, n[B]); Assert.Equal(300, n[A]);
}
[Fact] public void Currencies_are_never_mixed() { /* one ZAR + one USD expense → two keys, each sums to 0 */ }
[Fact] public void Simplify_chain_collapses() // A owes B 100, B owes C 100 → A pays C 100
    => Assert.Equal(new[] { new Transfer(A, C, 100) }, DebtSimplifier.Simplify(new Dictionary<Guid, long> { [A] = -100, [B] = 0, [C] = 100 }));
[Fact] public void Simplify_rejects_unbalanced() => Assert.Throws<ArgumentException>(() => DebtSimplifier.Simplify(new Dictionary<Guid, long> { [A] = 1 }));
[Property] public bool Simplify_preserves_every_net_position(/* random balanced nets */) { /* apply transfers to zero → all zero */ }
[Property] public bool Simplify_uses_at_most_n_minus_1_transfers(/* random balanced nets */) { }
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Simplifier: repeatedly match the largest creditor with the largest debtor (ties broken by `MemberOrder`), transfer `min(credit, -debt)`, until all zero. Zero-net members never appear in transfers.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(ledger): balance calculation and debt simplification`.

---

### Task 5: Persistence

**Files:**
- Create: `Data/LedgerDbContext.cs`, `Data/Entities/{User,Group,Member,Invite,Expense,ExpensePayer,ExpenseShare,Settlement,AuditEntry,IdempotencyRecord}.cs`, `Data/Migrations/*` (generated)
- Create: `IntegrationTests/Kitty.Ledger.IntegrationTests.csproj`, `IntegrationTests/LedgerApiFactory.cs`
- Test: `IntegrationTests/SchemaTests.cs`

**Interfaces:**
- Produces entities (all `Guid` ids, `DateTimeOffset` UTC timestamps):
  - `User { Id, KeycloakSub (unique), DisplayName, Email }`
  - `Group { Id, Name (1–60), BaseCurrency, CreatedByUserId, CreatedAt }`
  - `Member { Id, GroupId, DisplayName (1–40), UserId?, PaymentDetails? (≤500), JoinedAt }` — unique `(GroupId, UserId)` where UserId not null.
  - `Invite { Id, GroupId, Token (unique, 43-char base64url of 32 random bytes), MemberId?, CreatedByUserId, ExpiresAt, UsedAt?, UsedByUserId? }`
  - `Expense { Id (client-supplied), GroupId, Description (1–120), Category, Currency, AmountMinor, OccurredOn (DateOnly), SplitMethod, Version (int, concurrency token), CreatedByUserId, CreatedAt, UpdatedAt, DeletedAt? }` + owned collections `Payers: ExpensePayer { MemberId, AmountMinor }`, `Shares: ExpenseShare { MemberId, AmountMinor, InputValue? }`
  - `Settlement { Id (client-supplied), GroupId, FromMemberId, ToMemberId, Currency, AmountMinor, CreatedByUserId, CreatedAt, DeletedAt? }`
  - `AuditEntry { Id, GroupId, EntityType, EntityId, Action ("created"|"updated"|"deleted"), ActorUserId, At, Before (jsonb?), After (jsonb?) }`
  - `IdempotencyRecord { UserId, Key, RequestHash, Status ("in_progress"|"done"), StatusCode?, ResponseBody?, CreatedAt }` PK `(UserId, Key)`.
  - Category values: `food, groceries, transport, accommodation, utilities, rent, entertainment, shopping, other` (stored as lowercase string).
  - `LedgerApiFactory : WebApplicationFactory<Program>, IAsyncLifetime` — starts a `pgvector/pgvector:pg17` Testcontainer, sets `ConnectionStrings:ledger`, `Ledger:MigrateOnStartup=true`; exposes `CreateClientFor(string sub, string name = "Test User")` (wired in Task 6).

- [ ] **Step 1: Failing test** `Migrations_apply_and_member_user_is_unique_per_group`: insert a group, two members with the same `UserId` → `DbUpdateException`.
- [ ] **Step 2:** Run `dotnet test services/ledger/tests/Kitty.Ledger.IntegrationTests` → FAIL.
- [ ] **Step 3:** Implement entities + context; `dotnet ef migrations add Initial -o Data/Migrations`. `Program.cs` runs `MigrateAsync()` at startup when `Ledger:MigrateOnStartup` is true.
- [ ] **Step 4:** Run → PASS (Docker must be running).
- [ ] **Step 5:** Commit `feat(ledger): persistence model and initial migration`.

---

### Task 6: Auth, current user, Aspire and Keycloak

**Files:**
- Create: `Infrastructure/Auth/AuthSetup.cs`, `Infrastructure/Auth/CurrentUser.cs`, `Features/Me/MeEndpoints.cs`
- Create: `aspire/Kitty.AppHost/*`, `aspire/Kitty.ServiceDefaults/*`, `infra/keycloak/kitty-realm.json`
- Create: `IntegrationTests/TestTokens.cs`
- Test: `IntegrationTests/MeTests.cs`

**Interfaces:**
- Produces:
  - JWT bearer config: `Auth:Authority` (realm URL), `Auth:Audience = "kitty-ledger"`. Tests replace the signing key with `TestTokens.SigningKey` and issuer `https://test-issuer`.
  - `TestTokens.For(string sub, string name, string email) -> string`
  - `interface ICurrentUser { Task<User> GetAsync(CancellationToken) }` — upserts `User` by `sub` on first call per request (name from `name`/`preferred_username`, email from `email`).
  - `GET /me` → `{ id, displayName, email }`; `PATCH /me {displayName}` → same shape.
  - `GET /health` mapped in **all** environments (ServiceDefaults only maps it in Development by default).
  - Realm `kitty`: clients `kitty-web` (confidential, standard flow + PKCE S256, redirect `http://localhost:3000/*` + `${KITTY_PUBLIC_URL}/*`), audience mapper adding `kitty-ledger`; registration on; Google IdP present but disabled unless `GOOGLE_CLIENT_ID` set; passkeys enabled (Keycloak 26 passkeys feature); access token lifespan 300 s.
  - AppHost: Postgres (`pgvector/pgvector:pg17`, database `ledger`), Keycloak with realm import, `ledger` project referencing both, `web` JavaScript app (Task 12) with env `AUTH_KEYCLOAK_ISSUER`, `LEDGER_URL`.

- [ ] **Step 1: Failing tests**

```csharp
[Fact] public async Task Me_without_token_returns_401() =>
    Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateClient().GetAsync("/me")).StatusCode);
[Fact] public async Task Me_creates_user_on_first_call_and_is_stable()
{
    var c = _factory.CreateClientFor("sub-1", "Thandi");
    var first = await c.GetFromJsonAsync<MeDto>("/me"); var second = await c.GetFromJsonAsync<MeDto>("/me");
    Assert.Equal("Thandi", first!.DisplayName); Assert.Equal(first.Id, second!.Id);
}
[Fact] public async Task Token_with_wrong_audience_is_rejected() { }
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement auth + `/me`; scaffold AppHost/ServiceDefaults; write realm JSON.
- [ ] **Step 4:** Run tests → PASS. Then `dotnet run --project aspire/Kitty.AppHost`, open the Aspire dashboard: Postgres, Keycloak and ledger are healthy; `http://localhost:<keycloak>/realms/kitty/.well-known/openid-configuration` returns 200.
- [ ] **Step 5:** Commit `feat(ledger): OIDC auth via Keycloak, /me, Aspire app host`.

---

### Task 7: Errors and idempotency

**Files:**
- Create: `Infrastructure/Errors/ApiError.cs`, `Infrastructure/Idempotency/IdempotencyFilter.cs`, `Infrastructure/Idempotency/IdempotencyCleanup.cs`, `IntegrationTests/ApiClientExtensions.cs`
- Test: `IntegrationTests/IdempotencyTests.cs`

**Interfaces:**
- Produces:
  - `static IResult ApiError.Problem(int status, string code, string? detail = null)`. Error codes used by all later tasks:

    | code | status |
    |---|---|
    | `validation_failed` | 400 |
    | `currency_unsupported` | 400 |
    | `member_not_in_group` | 400 |
    | `split_empty` / `split_duplicate_member` / `split_sum_mismatch` / `split_invalid_value` / `payers_sum_mismatch` | 400 |
    | `idempotency_key_required` | 400 |
    | `not_found` | 404 |
    | `version_conflict` / `already_exists` / `already_member` / `invite_used` / `invite_expired` / `placeholder_claimed` / `request_in_progress` | 409 |
    | `idempotency_key_reused` | 422 |
    | `rate_limited` | 429 |

  - `IdempotencyFilter` (endpoint filter applied to every mutating route group): key = header; request hash = SHA-256 of method + path + body. Insert `in_progress` row first (PK conflict → if `done` and same hash, replay stored status+body; if different hash → 422; if `in_progress` → 409 `request_in_progress`). On completion store status + body (only 2xx and 4xx; on 5xx delete the row so the client can retry).
  - `IdempotencyCleanup : BackgroundService` — hourly, deletes rows older than 24 h.
  - Rate limiting: ASP.NET Core in-memory fixed window, 60 mutating requests/min per user → 429 `rate_limited` (single replica in phase 1; Redis-backed in phase 2). Test `Sixty_first_write_in_a_minute_returns_429` (configure a limit of 3 in the factory).
  - Test helpers: `PostJsonAsync(this HttpClient, string url, object body, string? key = null)`, `PutJsonAsync`, `PatchJsonAsync`, `DeleteAsync(url, key?)` — generate a new key when null.

- [ ] **Step 1: Failing tests** (use `PATCH /me` as the target)

```csharp
[Fact] public async Task Missing_key_returns_400() { /* raw PATCH without header → 400, code idempotency_key_required */ }
[Fact] public async Task Same_key_same_body_replays_identical_response() { }
[Fact] public async Task Same_key_different_body_returns_422() { }
[Fact] public async Task Keys_are_scoped_per_user() { /* user A and B use the same key → both succeed independently */ }
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(ledger): idempotency keys and problem-details errors`.

---

### Task 8: Groups, members, invites, audit

**Files:**
- Create: `Features/Groups/GroupEndpoints.cs`, `Features/Groups/GroupMemberFilter.cs`, `Features/Members/MemberEndpoints.cs`, `Features/Invites/InviteEndpoints.cs`, `Infrastructure/Audit/AuditWriter.cs`
- Test: `IntegrationTests/GroupTests.cs`, `IntegrationTests/InviteTests.cs`

**Interfaces:**
- Consumes: `ICurrentUser`, `ApiError`, `IdempotencyFilter`.
- Produces:
  - `GroupMemberFilter` on route group `/groups/{groupId:guid}` → 404 `not_found` unless the caller has a member row; puts `CallerMember` in `HttpContext.Items`.
  - `AuditWriter.Record(Guid groupId, string entityType, Guid entityId, string action, object? before, object? after)` — adds to the current `DbContext`; caller's `SaveChangesAsync` commits both.
  - `POST /groups {id, name, baseCurrency}` → 201 `GroupDto { id, name, baseCurrency, members: MemberDto[] }`; creator becomes a member. Existing id → 409 `already_exists`.
  - `GET /groups` → `GroupSummaryDto[] { id, name, baseCurrency, memberCount, myNet: [{currency, netMinor}] }` (myNet filled in Task 10; empty array until then).
  - `GET /groups/{id}`, `PATCH /groups/{id} {name}`
  - `MemberDto { id, displayName, userId?, isPlaceholder, paymentDetails? }`
  - `POST /groups/{id}/members {displayName}` → placeholder `MemberDto`.
  - `PATCH /groups/{id}/members/{memberId} {displayName?, paymentDetails?}` — allowed for your own member row or a placeholder; else 404.
  - `POST /groups/{id}/invites {memberId?}` → `{ token, expiresAt }` (7 days). `memberId` must be a placeholder in this group.
  - `GET /invites/{token}` → `{ groupName, placeholderName? , expiresAt }` (any signed-in user).
  - `POST /invites/{token}/accept` → `GroupDto`. Placeholder invite: sets `Member.UserId`. Open invite: creates a member. Errors: `invite_used`, `invite_expired`, `already_member`, `placeholder_claimed`. Invites are single-use (open invites too — the inviter makes one per person).

- [ ] **Step 1: Failing tests**

```csharp
[Fact] Create_group_makes_creator_a_member()
[Fact] Non_member_gets_404()                       // GET /groups/{id} as another user → 404
[Fact] Group_list_only_shows_my_groups()
[Fact] Add_placeholder_then_invite_claims_it()      // after accept: member.UserId == invitee, isPlaceholder false
[Fact] Accept_used_invite_returns_409()             // code invite_used
[Fact] Accept_when_already_member_returns_409()     // code already_member
[Fact] Expired_invite_returns_409()                 // use a TimeProvider fake registered in the factory
[Fact] Every_mutation_writes_an_audit_entry()
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (inject `TimeProvider` for expiry). **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(ledger): groups, placeholder members and invites`.

---

### Task 9: Expenses

**Files:**
- Create: `Features/Expenses/ExpenseDtos.cs`, `Features/Expenses/ExpenseValidator.cs`, `Features/Expenses/ExpenseEndpoints.cs`
- Test: `IntegrationTests/ExpenseTests.cs`, `UnitTests/ExpenseValidatorTests.cs`

**Interfaces:**
- Consumes: `SplitCalculator`, `Currencies`, `GroupMemberFilter`, `AuditWriter`.
- Produces:
  - `ExpenseWriteDto { id, description, category, currency, amountMinor, occurredOn (yyyy-MM-dd), payers: [{memberId, amountMinor}], split: { method: "equal"|"exact"|"percent"|"shares", participants: [{memberId, value?}] }, version? }`
  - `ExpenseDto` = write fields + `shares: [{memberId, amountMinor}]`, `version`, `createdBy`, `createdAt`, `updatedAt`.
  - `static ValidationResult ExpenseValidator.Validate(ExpenseWriteDto, IReadOnlySet<Guid> groupMemberIds)`: `amountMinor` 1..10_000_000_000; currency supported; payers non-empty, unique, Σ = amount (`payers_sum_mismatch`); every payer/participant in group (`member_not_in_group`); split via `SplitCalculator`.
  - `POST /groups/{id}/expenses` → 201 `ExpenseDto`, version 1. Existing id (non-idempotent replay) → 409 `already_exists`.
  - `PUT /groups/{id}/expenses/{expenseId}` — body must include `version`; mismatch → 409 `version_conflict`; success increments version.
  - `DELETE /groups/{id}/expenses/{expenseId}` → 204, soft delete.
  - `GET /groups/{id}/expenses?cursor=&limit=` (limit 1–100, default 30) → `{ items: ExpenseDto[], nextCursor? }`, keyset on `(occurredOn desc, createdAt desc, id desc)`, deleted excluded. Cursor is opaque base64url.

- [ ] **Step 1: Failing tests**

```csharp
[Fact] Create_equal_split_returns_shares_in_member_order()
[Fact] Create_with_foreign_member_returns_400()        // member of another group → member_not_in_group
[Fact] Create_with_payers_not_summing_returns_400()
[Fact] Create_with_placeholder_participant_succeeds()
[Fact] Put_with_stale_version_returns_409()             // two PUTs from version 1 → second is version_conflict
[Fact] Delete_hides_expense_from_list()
[Fact] List_pages_with_cursor_without_duplicates()     // 45 expenses, limit 20 → 20/20/5, all distinct
[Fact] Unsupported_currency_returns_400()
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(ledger): expenses with validation, versioning and soft delete`.

---

### Task 10: Balances, settlements, activity

**Files:**
- Create: `Features/Balances/BalanceEndpoints.cs`, `Features/Settlements/SettlementEndpoints.cs`, `Features/Activity/ActivityEndpoints.cs`
- Modify: `Features/Groups/GroupEndpoints.cs` (fill `myNet`)
- Test: `IntegrationTests/BalanceTests.cs`, `IntegrationTests/SettlementTests.cs`

**Interfaces:**
- Consumes: `BalanceCalculator`, `DebtSimplifier`.
- Produces:
  - `GET /groups/{id}/balances` → `{ currencies: [{ currency, members: [{memberId, netMinor}], transfers: [{fromMemberId, toMemberId, amountMinor}] }] }` — currencies sorted by code; members in member order.
  - `POST /groups/{id}/settlements {id, fromMemberId, toMemberId, currency, amountMinor}` → 201 `SettlementDto` (+ `createdBy`, `createdAt`). From ≠ To; both in group; amount ≥ 1.
  - `DELETE /groups/{id}/settlements/{settlementId}` → 204 soft delete.
  - `GET /groups/{id}/activity?before=&limit=` → `[{ id, at, actorDisplayName, entityType, entityId, action, before, after }]`, newest first.

- [ ] **Step 1: Failing tests**

```csharp
[Fact] Balances_sum_to_zero_per_currency()
[Fact] Settlement_of_suggested_transfer_zeroes_balances()   // record each suggested transfer → all nets 0, no transfers
[Fact] Deleted_expense_no_longer_affects_balances()
[Fact] Group_list_shows_my_net()
[Fact] Activity_lists_newest_first_with_actor_name()
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (load the group's non-deleted rows, map to `LedgerExpense`/`LedgerSettlement`, compute). **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(ledger): balances, settle up and activity feed`.

---

### Task 11: Shared TypeScript packages

**Files:**
- Create: `packages/money/{package.json,tsconfig.json,src/*.ts,test/*.test.ts}`, `packages/api-client/{package.json,src/index.ts,src/schema.d.ts,scripts/generate.mjs}`
- Modify: `Kitty.Ledger.csproj` (add `Microsoft.Extensions.ApiDescription.Server` so `dotnet build` writes `services/ledger/openapi/ledger.json`)

**Interfaces:**
- Produces:
  - `@kitty/money`: `exponent(code: string): number` (from `contracts/currencies.json`), `formatMoney(minor: number, currency: string, locale = "en-ZA"): string`, `parseMoney(input: string, currency: string): number | null` (string-based; rejects more decimals than the exponent; no float math), `previewSplit(totalMinor, method, participants): {memberId, minor}[] | {error: string}` — same algorithm and member order as Task 3.
  - `@kitty/api-client`: `createLedgerClient(baseUrl: string, getToken: () => Promise<string>): Client<paths>` (openapi-fetch) with middleware adding `Authorization` and, for mutations, `Idempotency-Key` from the request's `headers` if provided, else a fresh `crypto.randomUUID()`. Exports the `components["schemas"]` types.
  - `pnpm --filter @kitty/api-client generate` regenerates `schema.d.ts` from `services/ledger/openapi/ledger.json`.

- [ ] **Step 1: Failing tests** (`vitest`)

```ts
test("formats ZAR like Intl en-ZA", () =>
  expect(formatMoney(123456, "ZAR")).toBe(new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" }).format(1234.56)));
test("JPY has no decimals", () => expect(formatMoney(334, "JPY")).toContain("334"));
test("parse rejects 3 decimals for ZAR", () => expect(parseMoney("1.234", "ZAR")).toBeNull());
test("parse 12.5 ZAR = 1250", () => expect(parseMoney("12.5", "ZAR")).toBe(1250));
test("parse accepts comma decimal", () => expect(parseMoney("12,50", "ZAR")).toBe(1250));
test("shared split fixtures", () => { /* load contracts/fixtures/splits.json; assert previewSplit matches each */ });
```

- [ ] **Step 2:** Run `pnpm --filter @kitty/money test` → FAIL. **Step 3:** Implement both packages; run `dotnet build` then `generate`. **Step 4:** Tests PASS; `pnpm -r typecheck` PASS.
- [ ] **Step 5:** Commit `feat: shared money package and generated ledger client`.

---

### Task 12: Web — auth, groups, invites

**Files:**
- Create: `apps/web` (Next.js App Router, TypeScript strict, Tailwind, `output: "standalone"`), `src/auth/config.ts`, `src/auth/refresh.ts`, `src/lib/ledger.ts`, `src/app/page.tsx`, `src/app/groups/page.tsx`, `src/app/groups/new/page.tsx`, `src/app/invite/[token]/page.tsx`
- Modify: `aspire/Kitty.AppHost/AppHost.cs` (add web)
- Test: `apps/web/test/refresh.test.ts`

**Interfaces:**
- Consumes: `@kitty/api-client`, `@kitty/money`.
- Produces:
  - Auth.js Keycloak provider; env `AUTH_KEYCLOAK_ID`, `AUTH_KEYCLOAK_SECRET`, `AUTH_KEYCLOAK_ISSUER`, `AUTH_SECRET`. JWT session stores `accessToken`, `refreshToken`, `expiresAt`.
  - `refreshAccessToken(token: AuthToken, now: number, fetchFn = fetch): Promise<AuthToken>` — refresh when `expiresAt - 30 < now` (seconds); on failure returns `{...token, error: "RefreshAccessTokenError"}`; layouts redirect to sign-in when `session.error` is set.
  - `getLedger(): Promise<Client>` — server-only (`import "server-only"`), base URL `LEDGER_URL`.
  - Mutations are Server Actions. Each form renders a hidden `idempotencyKey` (`crypto.randomUUID()` at render), passed as the header, so a double-submit replays instead of duplicating.
  - Routes: `/` (sign in / redirect to `/groups`), `/groups` (list with my net per currency), `/groups/new` (name + base currency, default ZAR), `/invite/[token]` (preview + accept → redirect to group).

- [ ] **Step 1: Failing tests**

```ts
test("does not refresh a fresh token", async () => { /* expiresAt = now+300 → fetchFn not called */ });
test("refreshes a token about to expire", async () => { /* expiresAt = now+10 → returns new accessToken, new expiresAt */ });
test("marks error when refresh fails", async () => { /* fetchFn returns 400 → error === "RefreshAccessTokenError" */ });
```

- [ ] **Step 2:** Run `pnpm --filter web test` → FAIL. **Step 3:** Implement. **Step 4:** Tests PASS; `pnpm --filter web typecheck && pnpm --filter web build` PASS.
- [ ] **Step 5:** Manual check via Aspire: register in Keycloak, create a group, open an invite link as a second user (private window), accept it.
- [ ] **Step 6:** Commit `feat(web): sign-in, groups and invites`.

---

### Task 13: Web — group page, expenses, members, settle up

**Files:**
- Create: `src/app/groups/[id]/page.tsx` (balances + simplified transfers + expense list with "load more"), `src/app/groups/[id]/expenses/new/page.tsx`, `src/app/groups/[id]/expenses/[expenseId]/edit/page.tsx`, `src/components/ExpenseForm.tsx`, `src/app/groups/[id]/members/page.tsx`, `src/app/groups/[id]/settle/page.tsx`, `src/app/groups/[id]/activity/page.tsx`
- Test: `apps/web/test/expense-form.test.ts`

**Interfaces:**
- Consumes: Task 9–10 endpoints; `previewSplit`, `parseMoney`, `formatMoney`.
- Produces:
  - `ExpenseForm`: amount (parsed with `parseMoney`), description, category, date (default today), payer (default me; "multiple payers" toggle), split method tabs, live per-person preview from `previewSplit`; server errors mapped by `code` to inline messages (`split_sum_mismatch` → "Amounts must add up to {total}", `version_conflict` → "Someone else changed this expense. Reload to see their version.").
  - `toExpenseWriteDto(form: ExpenseFormState, members: MemberDto[]): ExpenseWriteDto | {error: string}` — pure function, unit-tested.
  - Members page: add placeholder, "invite" per placeholder and an open invite (copy link), edit own payment details.
  - Settle page: shows suggested transfers involving me; payee's `paymentDetails` with a copy button; "Mark as paid" records a settlement (either party may record).

- [ ] **Step 1: Failing tests** for `toExpenseWriteDto`: equal split builds participants with null values; percent converts "33.33" → 3333 bp; empty participant list → error; invalid amount → error.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Tests, typecheck, build PASS.
- [ ] **Step 5:** Manual check via Aspire with two users: add expense R100 split 3 ways incl. a placeholder → balances show 3334/3333/3333 owing; settle a suggested transfer → it disappears; edit the same expense in two tabs → the second save shows the conflict message.
- [ ] **Step 6:** Commit `feat(web): expenses, balances, members and settle up`.

---

### Task 14: CI

**Files:**
- Create: `.github/workflows/ledger.yml`, `.github/workflows/web.yml`, `.github/workflows/images.yml`, `services/ledger/Dockerfile`, `apps/web/Dockerfile`, `.dockerignore`

**Interfaces:**
- Produces:
  - `ledger.yml` (paths `services/ledger/**`, `contracts/**`): setup .NET 10, `dotnet test` unit + integration (Testcontainers on `ubuntu-latest`).
  - `web.yml` (paths `apps/**`, `packages/**`, `contracts/**`, `services/ledger/**`): pnpm install, `-r typecheck`, `-r test`, `web build`, plus **drift check**: `dotnet build` the ledger, regenerate the client, `git diff --exit-code packages/api-client/src/schema.d.ts`.
  - `images.yml` (push to `main`): buildx `linux/amd64,linux/arm64`, push `ghcr.io/<owner>/kitty-ledger` and `kitty-web` tagged `sha-<short>` and `latest`. Uses `GITHUB_TOKEN` with `packages: write`.
  - Ledger Dockerfile: SDK build stage → `mcr.microsoft.com/dotnet/aspnet:10.0` chiseled, non-root, port 8080. Web Dockerfile: pnpm workspace build → Next standalone on `node:24-alpine`, non-root, port 3000.

- [ ] **Step 1:** Write workflows and Dockerfiles.
- [ ] **Step 2:** Verify locally: `docker build -f services/ledger/Dockerfile .` and `docker build -f apps/web/Dockerfile .` succeed; `docker run` the ledger image → `/health` 200 with a reachable DB. Workflows themselves are verified on the first push (owner decides when to create the GitHub repo and push).
- [ ] **Step 3:** Commit `ci: test, drift-check and multi-arch image workflows`.

---

### Task 15: Interim deploy on Oracle Always Free

**Files:**
- Create: `deploy/compose/docker-compose.yml`, `deploy/compose/Caddyfile`, `deploy/compose/.env.example`, `deploy/compose/smoke.sh`, `deploy/compose/RUNBOOK.md`

**Interfaces:**
- Produces:
  - One public hostname `KITTY_HOST` (free DuckDNS subdomain, e.g. `kitty-xyz.duckdns.org`) — no paid domain needed. Caddy auto-TLS. Routing:

    ```
    {$KITTY_HOST} {
      handle /auth/* { reverse_proxy keycloak:8080 }
      handle_path /api/* { reverse_proxy ledger:8080 }
      handle { reverse_proxy web:3000 }
    }
    ```

  - Keycloak: `KC_HTTP_RELATIVE_PATH=/auth`, `KC_HOSTNAME=https://${KITTY_HOST}/auth`, `KC_PROXY_HEADERS=xforwarded`, realm import on boot, its own database in the same Postgres.
  - The caddy service has a network alias equal to `${KITTY_HOST}`, so containers reach the public URL internally (no hairpin NAT) and every service uses the same issuer `https://${KITTY_HOST}/auth/realms/kitty`.
  - Services: `postgres` (pgvector image, named volume), `keycloak`, `ledger` (`Ledger:MigrateOnStartup=true`), `web`, `caddy` (volumes for certs). All images from GHCR, tag via `KITTY_TAG`. Memory limits set so the total stays under 6 GB, leaving room for later phases in 12 GB.
  - `.env.example`: `KITTY_HOST, KITTY_TAG, POSTGRES_PASSWORD, KEYCLOAK_ADMIN_PASSWORD, AUTH_SECRET, AUTH_KEYCLOAK_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET`.
  - `smoke.sh <host>`: `/` 200, `/api/health` 200, `/auth/realms/kitty/.well-known/openid-configuration` 200 with `issuer` = `https://<host>/auth/realms/kitty`.
  - `RUNBOOK.md`: create A1 VM (Ubuntu 24.04, ≤2 OCPU/12 GB — exceeding the free allowance disables instances), reserve the public IP, open 80/443 in the VCN security list **and** in the image's iptables rules, install Docker, point DuckDNS at the IP, copy `deploy/compose`, fill `.env`, `docker compose pull && docker compose up -d`, run `smoke.sh`. Updating = set `KITTY_TAG`, pull, up.

- [ ] **Step 1:** Write the files. Verify locally: `docker compose --env-file .env.local up` with `KITTY_HOST=localhost` (Caddy internal TLS) → `smoke.sh localhost` passes, and you can sign in and create a group at `https://localhost`.
- [ ] **Step 2: Owner action (confirm before running — this modifies cloud infrastructure):** create the Oracle VM and DuckDNS name, follow RUNBOOK, run `smoke.sh` against the real host.
- [ ] **Step 3:** Commit `feat(deploy): interim compose deployment with Caddy and DuckDNS`.

---

## Phase 1 done when

- All ledger unit + integration tests, web tests, typecheck and builds pass.
- `dotnet run --project aspire/Kitty.AppHost` brings the whole stack up from a fresh clone.
- Two real people can sign in at `https://<KITTY_HOST>`, share a group, split an expense and settle it.
