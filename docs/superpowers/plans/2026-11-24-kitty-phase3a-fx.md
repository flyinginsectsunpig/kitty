# Kitty Phase 3a — pulse, Exchange Rates and Multi-currency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Go service, `pulse`, serves ECB exchange rates over gRPC. The ledger stores a rate on each foreign-currency
expense and settlement, and balances gain a total in the group's currency. Web and mobile show and edit rates and can
settle a foreign debt in the group's currency.

**Architecture:**
- `pulse` (`services/pulse`) is a gRPC server (`kitty.fx.v1.RatesService`) backed by Frankfurter and its own `pulse`
  schema in the shared Postgres.
- The ledger calls it through `IFxRates` (a gRPC client). Conversion is pure domain code (`FxConverter`), mirrored in
  `@kitty/money` and pinned by the shared fixture `contracts/fixtures/fx.json`.
- Clients only display rates. They send `fxRate` only when the person typed one.

**Tech Stack:**
- Go 1.27: grpc-go, protobuf-go, pgx v5, shopspring/decimal, testcontainers-go, buf (as a Go tool)
- .NET 10: `Grpc.Net.ClientFactory`
- Existing: EF Core and Postgres, Next.js, Expo, vitest, jest-expo

**Spec:** `docs/superpowers/specs/2026-11-24-kitty-phase3a-fx-design.md`

## Global Constraints

- **New dependencies (exact pins; the owner approved the list in the spec §5):**
  - **Go:**
    - `google.golang.org/grpc v1.85.0`, `google.golang.org/protobuf v1.36.12`
    - `github.com/jackc/pgx/v5 v5.13.0`, `github.com/shopspring/decimal v1.6.0`
    - `github.com/testcontainers/testcontainers-go v0.45.0` (and its `modules/postgres` at the same version)
    - tools via `go get -tool`: `github.com/bufbuild/buf/cmd/buf v1.75.0`, `google.golang.org/protobuf/cmd/protoc-gen-go`, `google.golang.org/grpc/cmd/protoc-gen-go-grpc` (latest stable)
  - **.NET:** `Grpc.Net.ClientFactory 2.85.0` in `Directory.Packages.props`.
  - Anything else needs the owner's OK first.
- **No floats in the money path:**
  - Rates are decimal strings in JSON and Protobuf.
  - Storage and code types: `numeric(20,10)` in Postgres, `decimal`/`BigInteger` in C#, `decimal.Decimal` in Go, `BigInt` in TypeScript.
  - Converted amounts are integer minor units.
- **Rate validation:**
  - The string must match `^(0|[1-9]\d{0,6})(\.\d{1,10})?$`, be > 0 and ≤ 1,000,000.
  - Canonical form: trailing zeros trimmed, e.g. `"19.1987"`.
- **Conversion rule (ledger and TypeScript identical):**
  - `rateScaled = rate × 10^10` (exact).
  - `num = minor × rateScaled × 10^max(0, eTo−eFrom)`, `den = 10^10 × 10^max(0, eFrom−eTo)`.
  - Result = `num / den`, rounded half away from zero. Inputs are ≥ 0.
- **Spreading a converted total over payers or shares:**
  - Floor each converted part, then +1 to members in `MemberOrder` until the parts sum to the converted total.
  - This is the same rule `SplitCalculator` uses.
- **Error codes (snake_case, added to `ErrorCodes` and core's `errorMessage`):**
  - `fx_rate_unavailable` (503): "Couldn't get today's exchange rate. Type the rate instead."
  - `fx_rate_required` (422): "We couldn't look up the exchange rate. Enter it to record this payment."
  - `fx_rate_invalid` (400): "That exchange rate doesn't look right."
- **pulse configuration (env):**
  - `PULSE_PORT` (default `5090`) and `PULSE_FRANKFURTER_URL` (default `https://api.frankfurter.dev/v1`).
  - `PULSE_DATABASE_URL` is required; pulse exits non-zero at startup without it.
- **Ledger configuration:** `Fx:Url` (env `Fx__Url`) is required; startup throws without it.
- Commits are conventional, one logical change each. No attribution lines.

## Review Focus

1. **An expense dated on a Saturday or a public holiday.** It must get the previous ECB working day's rate, with that
   date shown. *Test:* Task 3 `TestStore_AskedDateMapsToEarlierEcbDate` and Task 4 `TestGetRate_WeekendUsesFetchedEcbDate`.
2. **A back-dated expense for a date pulse has never fetched, while older dates are stored.** It must fetch, not reuse
   the nearest stored rate. *Test:* Task 4 `TestGetRate_UnseenDateFetchesEvenWhenOlderDatesStored`.
3. **Currencies with no minor units (JPY, KRW, ISK) in either direction.** The rounding must match on server and client.
   *Test:* Task 5 fixture rows `JPY to ZAR` and `ZAR to JPY`, run by both languages.
4. **Editing only an expense's description weeks later.** The saved rate must not change, even though ECB rates moved.
   *Test:* Task 7 `Editing_description_keeps_the_saved_rate`.
5. **pulse down when the host confirms a table bill in a foreign currency.** The expense must still be saved, without a
   rate. *Test:* Task 7 `Table_confirm_saves_without_rate_when_pulse_is_down`.

---

### Task 1: The rates contract and the pulse Go module

**Files:**
- Create: `contracts/proto/kitty/fx/v1/rates.proto`
- Create: `services/pulse/go.mod`, `services/pulse/buf.yaml`, `services/pulse/buf.gen.yaml`
- Create (generated, committed): `services/pulse/gen/kitty/fx/v1/*.pb.go`
- Create: `services/pulse/README.md` (how to run, generate and test)

**Interfaces:**
- Produces: the proto below. C# namespace `Kitty.Contracts.Fx.V1`, Go package `fxv1` at
  `github.com/flyinginsectsunpig/kitty/services/pulse/gen/kitty/fx/v1`.

```proto
syntax = "proto3";
package kitty.fx.v1;
option csharp_namespace = "Kitty.Contracts.Fx.V1";
option go_package = "github.com/flyinginsectsunpig/kitty/services/pulse/gen/kitty/fx/v1;fxv1";

// Exchange rates from the ECB (via Frankfurter). Rates are decimal strings, never floats.
service RatesService {
  rpc GetRate(GetRateRequest) returns (GetRateResponse);
}
message GetRateRequest {
  string base = 1;  // ISO 4217, e.g. "EUR"
  string quote = 2; // ISO 4217, e.g. "ZAR"
  string date = 3;  // YYYY-MM-DD; a future date means today
}
message GetRateResponse {
  string rate = 1;      // 1 base = rate quote, up to 10 decimal places
  string rate_date = 2; // the ECB date actually used, YYYY-MM-DD
  string source = 3;    // "ecb"
}
```

- [ ] **Step 1:** `go mod init github.com/flyinginsectsunpig/kitty/services/pulse` (go 1.27). Add the three tools with `go get -tool`.
- [ ] **Step 2:** Write `buf.yaml` (v2):
  - module path `../../contracts/proto`;
  - lint `STANDARD`, limited to `kitty/fx`, because the existing event protos predate buf.

  Write `buf.gen.yaml`:
  - local plugins `["go","tool","protoc-gen-go"]` and `["go","tool","protoc-gen-go-grpc"]`;
  - `out: gen`, `opt: paths=source_relative`;
  - input `../../contracts/proto` with `paths: [kitty/fx]`.
- [ ] **Step 3:** Run: `cd services/pulse && go tool buf lint && go tool buf generate && go build ./...`
  Expected: no lint errors; `gen/kitty/fx/v1/rates.pb.go` and `rates_grpc.pb.go` exist; the build succeeds.
- [ ] **Step 4:** In `services/ledger/src/Kitty.Ledger/Kitty.Ledger.csproj`:
  - keep the existing `<Protobuf>` item for `kitty/events/**` with `GrpcServices="None"`;
  - add one for `kitty/fx/**` with `GrpcServices="Client"`.

  Run `dotnet build services/ledger/src/Kitty.Ledger`. Expected: builds, and `Kitty.Contracts.Fx.V1.RatesService.RatesServiceClient` exists.
- [ ] **Step 5: Commit** `feat(pulse): rates gRPC contract and Go module`

### Task 2: Cross rates and the Frankfurter client (Go)

**Files:**
- Create: `services/pulse/internal/fx/rates.go`, `services/pulse/internal/fx/frankfurter.go`
- Test: `services/pulse/internal/fx/rates_test.go`, `services/pulse/internal/fx/frankfurter_test.go`

**Interfaces:**
- Produces:
  - `type Day struct { Date time.Time; PerEUR map[string]decimal.Decimal }`. `PerEUR` never contains "EUR"; EUR is implicitly 1.
  - `func CrossRate(day Day, base, quote string) (decimal.Decimal, error)`. Returns `ErrUnknownCurrency` when either side is missing; same currency gives `1`.
  - `type Frankfurter struct { BaseURL string; HTTP *http.Client }`
  - `func (f Frankfurter) Day(ctx context.Context, date *time.Time) (Day, error)`: nil means `/latest`, else `/{YYYY-MM-DD}`. The returned `Day.Date` is the response's `date`, i.e. the ECB date actually used.

- [ ] **Step 1: Write failing tests**
  - `TestCrossRate_EURBase`: PerEUR{ZAR:19.1987}, EUR→ZAR = `19.1987`.
  - `TestCrossRate_Cross`: PerEUR{USD:1.099, ZAR:19.1987}, USD→ZAR = `17.4692447680`. That is 19.1987/1.099 computed with `DivRound(…, 20)` then `RoundBank(10)`.
  - `TestCrossRate_ToEUR`: ZAR→EUR = `0.0520868600` (1/19.1987, same rounding).
  - `TestCrossRate_Same`: ZAR→ZAR = `1`.
  - `TestCrossRate_Unknown`: XYZ returns `ErrUnknownCurrency`.
  - `TestFrankfurter_DayParsesDateAndRates`: an `httptest` server returns the real response shape
    `{"amount":1.0,"base":"EUR","date":"2026-11-20","rates":{"USD":1.099,"ZAR":19.1987}}` for `/2026-11-22`. Expect
    `Date` 2026-11-20, `PerEUR["ZAR"]` = `19.1987`. Parse the rates with `decimal` from the raw JSON number text
    (`json.Number`), never via float64.
  - `TestFrankfurter_Latest`: requests `/latest`.
  - `TestFrankfurter_Non200IsError`: a 503 returns an error.
- [ ] **Step 2:** `go test ./internal/fx/...`. Expected: FAIL (undefined).
- [ ] **Step 3:** Implement. The HTTP client gets a 10 s timeout.
- [ ] **Step 4:** `go test ./internal/fx/...`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pulse): ECB cross rates from Frankfurter`

### Task 3: The rate store (Go, Postgres)

**Files:**
- Create: `services/pulse/internal/fx/store.go`
- Test: `services/pulse/internal/fx/store_test.go` (Testcontainers `pgvector/pgvector:pg17`, same image as the ledger)

**Interfaces:**
- Produces:
  - `func OpenStore(ctx context.Context, url string) (*Store, error)`. Opens a `pgxpool` and creates the schema if missing:

    ```sql
    CREATE SCHEMA IF NOT EXISTS pulse;
    CREATE TABLE IF NOT EXISTS pulse.ecb_rates (ecb_date date NOT NULL, currency char(3) NOT NULL,
      per_eur numeric(20,10) NOT NULL, PRIMARY KEY (ecb_date, currency));
    CREATE TABLE IF NOT EXISTS pulse.date_map (asked_date date PRIMARY KEY, ecb_date date NOT NULL,
      fetched_at timestamptz NOT NULL);
    ```

  - `func (s *Store) Save(ctx context.Context, asked time.Time, day Day) error`. Upserts the day's rates and `asked → day.Date` in one transaction.
  - `func (s *Store) Lookup(ctx context.Context, asked time.Time) (Day, bool, error)`. Returns the day only when `asked` is in `date_map`.
  - `func (s *Store) Close()`

- [ ] **Step 1: Write failing tests** (one container per package via `TestMain`)
  - `TestStore_SaveThenLookup`: save asked 2026-11-20 with Day 2026-11-20 {ZAR:19.1987}; Lookup returns it.
  - `TestStore_AskedDateMapsToEarlierEcbDate`: save asked 2026-11-22 (a Sunday) with Day 2026-11-20. Lookup(2026-11-22) has Date 2026-11-20.
  - `TestStore_UnaskedDateIsNotFound`: after the saves above, Lookup(2026-06-10) gives `ok == false`, even though earlier and later dates are stored.
  - `TestStore_SaveIsIdempotent`: saving the same asked date twice with new rates leaves one mapping and the newer rates.
- [ ] **Step 2:** `go test ./internal/fx/ -run Store`. Expected: FAIL.
- [ ] **Step 3:** Implement with `pgx/v5`, passing decimals as strings.
- [ ] **Step 4:** `go test ./internal/fx/ -run Store`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(pulse): store ECB rates and which date each request resolved to`

### Task 4: The gRPC service, daily refresh and `cmd/pulse`

**Files:**
- Create: `services/pulse/internal/fx/service.go` (lookup logic plus the gRPC server)
- Create: `services/pulse/internal/fx/refresh.go` (daily refresh)
- Create: `services/pulse/cmd/pulse/main.go` (wiring, and `-health` for container health checks)
- Test: `services/pulse/internal/fx/service_test.go` (fakes for the source and store; gRPC over `bufconn`)

**Interfaces:**
- Consumes: `Day`, `CrossRate`, `Frankfurter.Day`, `Store.Lookup` and `Store.Save` from Tasks 2–3.
- Produces:
  - `type Source interface { Day(ctx context.Context, date *time.Time) (Day, error) }`
  - `type Rates interface { Lookup(context.Context, time.Time) (Day, bool, error); Save(context.Context, time.Time, Day) error }`
  - `type Service struct { fxv1.UnimplementedRatesServiceServer; Source Source; Store Rates; Now func() time.Time }`
  - `func (s *Service) GetRate(ctx, *fxv1.GetRateRequest) (*fxv1.GetRateResponse, error)`:
    - parse the date: an invalid date, or one before 1999-01-04, gives `InvalidArgument`;
    - clamp a future date to today (UTC);
    - Lookup; on a miss, fetch (`nil` for today, else the date) and Save;
    - `CrossRate`: unknown currency gives `InvalidArgument`;
    - a source failure on a miss gives `Unavailable`;
    - respond with `rate` (`StringFixed` trimmed of trailing zeros), `rate_date`, `source: "ecb"`.
  - `func RefreshDaily(ctx context.Context, s *Service, every time.Duration)`: fetches `/latest` at startup and then each tick, saving it under today (UTC). It runs in `main` with a 1-hour tick, so today's mapping catches up with the ECB's afternoon publish.

- [ ] **Step 1: Write failing tests**
  - `TestGetRate_HitDoesNotFetch`
  - `TestGetRate_MissFetchesAndSaves`
  - `TestGetRate_WeekendUsesFetchedEcbDate`: asked 2026-11-22, the source returns Day 2026-11-20. The response has `rate_date` "2026-11-20", and the store saved 22 → 20.
  - `TestGetRate_UnseenDateFetchesEvenWhenOlderDatesStored`
  - `TestGetRate_FutureDateMeansToday`: the source is called with `nil`.
  - `TestGetRate_BeforeECBIsInvalidArgument`: 1998-12-31.
  - `TestGetRate_UnknownCurrencyIsInvalidArgument`
  - `TestGetRate_SourceDownOnMissIsUnavailable`
  - `TestGetRate_OverGRPC`: the bufconn round trip, EUR→ZAR `19.1987`.
  - `TestRefresh_SavesLatestUnderToday`
- [ ] **Step 2:** `go test ./...`. Expected: FAIL.
- [ ] **Step 3:** Implement. `main` does the following:
  - read the env (see Global Constraints) and fail fast when `PULSE_DATABASE_URL` is missing;
  - `OpenStore`, then start `RefreshDaily`;
  - register `RatesService` and `grpc_health_v1` (`health.NewServer()`, status SERVING), and serve on `:PULSE_PORT`;
  - log through `log/slog`;
  - `pulse -health` dials `localhost:PULSE_PORT`, checks health, and exits 0 or 1.
- [ ] **Step 4:** `go vet ./... && go test ./...`. Expected: PASS.
- [ ] **Step 5:** Manual run against the local Postgres: start the stack, run `go run ./cmd/pulse`, then call `GetRate EUR ZAR 2026-11-22` with `go tool buf curl --protocol grpc --http2-prior-knowledge`. Expected: `rate_date` 2026-11-20.
- [ ] **Step 6: Commit** `feat(pulse): GetRate over gRPC with daily refresh and health`

### Task 5: Conversion rule, C# and TypeScript, one fixture

**Files:**
- Create: `contracts/fixtures/fx.json`
- Create: `services/ledger/src/Kitty.Ledger/Domain/Fx/FxRate.cs`, `services/ledger/src/Kitty.Ledger/Domain/Fx/FxConverter.cs`
- Test: `services/ledger/tests/Kitty.Ledger.UnitTests/FxFixtureTests.cs`, `services/ledger/tests/Kitty.Ledger.UnitTests/FxConverterTests.cs`
- Create: `packages/money/src/fx.ts`. Modify: `packages/money/src/index.ts`
- Test: `packages/money/test/fx.test.ts`

**Interfaces:**
- Produces (C#):
  - `public static class FxRate { bool TryParse(string? s, out decimal rate); string Format(decimal rate); }`. Rules are in Global Constraints. `Format` gives the canonical string.
  - `public static class FxConverter { long Convert(long minor, decimal rate, string from, string to); IReadOnlyList<Share> Spread(IReadOnlyList<Share> parts, decimal rate, string from, string to); }`.
    - `Spread` returns parts summing to `Convert(sum)`, in `MemberOrder`.
    - Both throw on negative input.
- Produces (TS, exported from `@kitty/money`):
  - `parseRate(input: string): string | null` (canonical, or null when invalid)
  - `convertMinor(minor: number, rate: string, from: string, to: string): number`

- [ ] **Step 1: Write the fixture** `contracts/fixtures/fx.json`, as
  `{ "rates": [...], "conversions": [...], "spreads": [...] }`.
  - **`rates`** (`{input, canonical|null}`):
    - `"19.19870"` → `"19.1987"`; `"0.0000000001"` ok; `"1000000"` ok;
    - `"1000000.1"`, `"0"`, `"-1"`, `"1e3"`, `"01.5"`, `"1.12345678901"` and `""` → null.
  - **`conversions`** (`{name, minor, rate, from, to, expected}`):
    - `EUR to ZAR`: 4000, `19.1987`, EUR→ZAR = 76795
    - `half rounds away from zero`: 1, `0.5`, EUR→ZAR = 1
    - `JPY to ZAR`: 1000, `0.1101`, JPY→ZAR = 11010
    - `ZAR to JPY`: 10000, `9.0807`, ZAR→JPY = 908
    - `zero`: 0 → 0
  - **`spreads`** (`{name, parts:[{memberId, minor}], rate, from, to, expected:[…]}`): members
    `00000001-…`/`00000002-…`/`00000003-…` with 1333/1333/1334 of EUR 40.00 at `19.1987`. The parts floor to 25591/25591/25611 (sum 76793), and the 2-unit remainder goes +1 to
    the first two in member order, so expected is 25592/25592/25611, summing to 76795.
- [ ] **Step 2: Write failing tests**
  - `FxFixtureTests` runs every fixture row (like `SplitFixtureTests`, copying the file to the test output `fixtures/`
    the same way `splits.json` is copied).
  - `FxConverterTests.Spread_always_sums_to_the_converted_total`: a property-style loop over 1,000 seeded random
    inputs, covering 1–5 parts, rates `0.0001`–`200000` and all exponent pairs.
  - `fx.test.ts` runs `rates` and `conversions` from the same file.
- [ ] **Step 3:** `dotnet test services/ledger/tests/Kitty.Ledger.UnitTests --filter Fx` and `pnpm --filter @kitty/money test`. Expected: FAIL.
- [ ] **Step 4:** Implement with `BigInteger` in C# and `BigInt` in TS, using the formula in Global Constraints.
- [ ] **Step 5:** Re-run both. Expected: PASS.
- [ ] **Step 6: Commit** `feat(money): exchange-rate parsing and conversion shared by ledger and clients`

### Task 6: The ledger's rates client and `GET /fx-rate`

**Files:**
- Create: `services/ledger/src/Kitty.Ledger/Infrastructure/Fx/IFxRates.cs`, `services/ledger/src/Kitty.Ledger/Infrastructure/Fx/GrpcFxRates.cs`
- Create: `services/ledger/src/Kitty.Ledger/Features/Fx/FxEndpoints.cs`
- Modify: `Program.cs`, `Infrastructure/Errors/ErrorCodes.cs`, `Infrastructure/Errors/ApiError.cs` (add a 503 and a 422 helper), `Directory.Packages.props`, `Kitty.Ledger.csproj`
- Create: `services/ledger/tests/Kitty.Ledger.IntegrationTests/FakeFxRates.cs`. Modify: `LedgerApiFactory.cs`
- Test: `services/ledger/tests/Kitty.Ledger.IntegrationTests/FxRateTests.cs`

**Interfaces:**
- Produces:
  - `public sealed record FxQuote(decimal Rate, DateOnly RateDate);`
  - `public interface IFxRates { Task<FxQuote?> GetAsync(string from, string to, DateOnly date, CancellationToken ct); }`. Null means unavailable.
  - `GrpcFxRates`:
    - 3 s deadline;
    - any `RpcException` returns null and logs a warning with the status code;
    - registered with `AddGrpcClient<RatesService.RatesServiceClient>(o => o.Address = new Uri(Fx:Url))`;
    - throws at startup when `Fx:Url` is missing.
  - `FakeFxRates : IFxRates`:
    - `Set(string from, string to, DateOnly date, decimal rate, DateOnly? rateDate = null)` and `Down` (bool);
    - an unknown pair returns null;
    - the factory registers it as a singleton and exposes it as `factory.Fx`;
    - the factory sets `Fx:Url` to `http://localhost:1`.
  - `GET /groups/{groupId}/fx-rate?currency=&date=` → `FxRateDto(string Rate, DateOnly RateDate, string Source)`, name `GetFxRate`.
    - Unsupported currency, or the group's own currency: `400 currency_unsupported` / `validation_failed`.
    - Unavailable: `503 fx_rate_unavailable`.
- [ ] **Step 1: Write failing tests**
  - `Returns_the_rate_for_a_foreign_currency`: EUR, 2026-11-22 → `"19.1987"`, rateDate 2026-11-20, source `ecb`.
  - `Pulse_down_is_503_fx_rate_unavailable`
  - `Own_currency_is_rejected`
  - `Non_member_gets_404` (the group filter, like the other group routes)
- [ ] **Step 2:** `dotnet test services/ledger/tests/Kitty.Ledger.IntegrationTests --filter FxRateTests`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ledger): exchange-rate lookups through pulse`

### Task 7: Rates on expenses

**Files:**
- Modify:
  - `Data/Entities/Entities.cs`: `Expense` gains `decimal? FxRate`, `DateOnly? FxRateDate`, `string? FxRateSource`, `long? ConvertedAmountMinor`.
  - `Data/LedgerDbContext.cs`: `numeric(20,10)`, `varchar(6)`.
  - New migration `ExpenseFxRates`.
- Create: `services/ledger/src/Kitty.Ledger/Features/Fx/RateDecision.cs`
- Modify: `Features/Expenses/ExpenseDtos.cs`, `Features/Expenses/ExpenseEndpoints.cs`, `Features/Table/TableEndpoints.cs` (confirm)
- Test: `services/ledger/tests/Kitty.Ledger.IntegrationTests/ExpenseFxTests.cs`, and the existing `TableSessionTests.cs`

**Interfaces:**
- Consumes: `IFxRates`, `FxRate`, `FxConverter`.
- Produces:
  - `RateDecision` subtypes:
    - `None` (the group's own currency)
    - `Rate(decimal Value, DateOnly? EcbDate, string Source)`, where Source is `"ecb"` or `"manual"`
    - `Missing`
    - `Invalid(string Detail)`
  - `public sealed class ExpenseRates(IFxRates fx) { Task<RateDecision> DecideAsync(string currency, string groupCurrency, DateOnly occurredOn, string? sentRate, Expense? existing, CancellationToken ct); }` (scoped). Rules from spec §3.2:
    - same currency + `sentRate` → `Invalid`;
    - `sentRate` → `Rate(manual)`;
    - `existing` with a rate and the same currency and date → keep it;
    - else fetch → `Rate(ecb)` or `Missing`.
  - `ExpenseWriteDto` gains `string? FxRate`. `ExpenseDto` gains `string? FxRate, DateOnly? FxRateDate, string? FxRateSource, long? ConvertedAmountMinor`.
  - On save:
    - `Invalid` → `400 fx_rate_invalid`;
    - a converted amount above `SplitCalculator.MaxTotalMinor` → `400 fx_rate_invalid` "Converted amount is too large.";
    - `Missing` saves with all four fields null.
  - Table confirm: decide (no `sentRate`, no existing) **before** opening the transaction, and apply the result to the new expense.
- [ ] **Step 1: Write failing tests**
  - `Foreign_expense_gets_the_ecb_rate`: EUR 40.00 on 2026-11-22 → fxRate `19.1987`, fxRateDate 2026-11-20, source `ecb`, converted 76795.
  - `Typed_rate_is_saved_as_manual`
  - `Own_currency_has_no_rate_and_rejects_one`
  - `Pulse_down_saves_without_rate` (201 with all four fields null)
  - `Editing_description_keeps_the_saved_rate`: change the fake's rate after creating; a PUT with only the description changed keeps `19.1987`.
  - `Changing_the_date_refetches`
  - `Converted_overflow_is_fx_rate_invalid`
  - `Invalid_rate_string_is_fx_rate_invalid`
  - In `TableSessionTests`:
    - `Table_confirm_in_foreign_currency_stores_the_rate`
    - `Table_confirm_saves_without_rate_when_pulse_is_down`
- [ ] **Step 2:** Run the filters. Expected: FAIL.
- [ ] **Step 3:** Implement, then add the migration: `dotnet ef migrations add ExpenseFxRates --project services/ledger/src/Kitty.Ledger`.
- [ ] **Step 4:** Run the full ledger suite: `dotnet test --solution Kitty.slnx`. Expected: PASS, including `SchemaTests` and `OpenApiTests`. Rewrite the contract with `KITTY_UPDATE_OPENAPI=1` once, then run again without it.
- [ ] **Step 5: Commit** `feat(ledger): store an exchange rate on foreign-currency expenses`

### Task 8: Rates on settlements

**Files:**
- Modify:
  - `Entities.cs`: `Settlement` gains `decimal? FxRate`, `DateOnly? FxRateDate`, `string? FxRateSource`, `long? ConvertedAmountMinor`, `bool PaidInGroupCurrency`.
  - The DbContext and a migration `SettlementFxRates`.
  - `Features/Settlements/SettlementEndpoints.cs`.
- Test: `services/ledger/tests/Kitty.Ledger.IntegrationTests/SettlementFxTests.cs`

**Interfaces:**
- Consumes: `ExpenseRates.DecideAsync` is reused with `occurredOn` = today (UTC, from `TimeProvider`) and `existing: null`.
- Produces:
  - `SettlementWriteDto` gains `string? FxRate, bool PaidInGroupCurrency`.
  - `SettlementDto` gains `string? FxRate, DateOnly? FxRateDate, string? FxRateSource, long? ConvertedAmountMinor, bool PaidInGroupCurrency`.
  - Errors:
    - `Missing` → `422 fx_rate_required`;
    - `PaidInGroupCurrency` with the group's own currency → `400 validation_failed`.
- [ ] **Step 1: Write failing tests**
  - `Foreign_settlement_gets_todays_rate`
  - `Pay_in_group_currency_stores_the_paid_amount`: EUR 20.00 at typed `19.5`, paid in ZAR → converted 39000, `paidInGroupCurrency` true, source `manual`.
  - `Pulse_down_without_rate_is_422`
  - `Pulse_down_with_typed_rate_succeeds`
  - `Pay_in_group_currency_needs_a_foreign_currency`
  - `Settlement_still_reduces_the_debts_currency`: the EUR balance goes to 0 after an EUR settlement paid in ZAR.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement and add the migration.
- [ ] **Step 4:** `dotnet test --solution Kitty.slnx`, updating the OpenAPI contract as in Task 7. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ledger): settle a foreign-currency debt in the group's currency`

### Task 9: The converted total on balances

**Files:**
- Create: `services/ledger/src/Kitty.Ledger/Domain/Balances/ConvertedBalances.cs` (pure)
- Modify: `Features/Balances/BalanceEndpoints.cs`
- Test: `services/ledger/tests/Kitty.Ledger.UnitTests/ConvertedBalancesTests.cs`, and `BalanceTests.cs` (integration)

**Interfaces:**
- Consumes: `FxConverter.Spread`, `BalanceCalculator`, `DebtSimplifier`.
- Produces:
  - `public sealed record ConvertibleExpense(string Currency, decimal? FxRate, IReadOnlyList<Share> Payers, IReadOnlyList<Share> Shares);`
  - `public sealed record ConvertibleSettlement(string Currency, Guid From, Guid To, long Minor, long? ConvertedMinor);`
  - `public static (IReadOnlyDictionary<Guid,long> Nets, int Excluded) ConvertedBalances.Compute(string groupCurrency, IEnumerable<ConvertibleExpense>, IEnumerable<ConvertibleSettlement>)`
    - Rows already in the group's currency pass through.
    - A foreign expense with a rate is spread; without one, it counts as excluded.
    - A foreign settlement uses `ConvertedMinor`; null counts as excluded.
  - `ConvertedBalanceDto(string Currency, IReadOnlyList<MemberNetDto> Members, IReadOnlyList<TransferDto> Transfers, int ExcludedCount)`.
  - `BalancesDto` gains `ConvertedBalanceDto? Converted`. It is **null** when every per-currency net is 0, or when every row is in the group's currency (Ruling: the spec hides the card in both cases; the server says so once).
- [ ] **Step 1: Write failing tests**
  - **Unit:**
    - `Converted_nets_sum_to_zero`: property loop.
    - `Rows_without_rate_are_excluded_and_counted`
    - `Drift_shows_as_a_leftover`: an EUR 40.00 expense at `19.1987`, paid by A (`00000001-…`) and split equally
      with B (`00000002-…`). The converted shares are 38398 (A) and 38397 (B). B then settles EUR 20.00, paid in ZAR at
      `19.5`, which converts to 39000. Expected: the per-currency EUR nets are 0/0, and the converted nets are
      A −603 and B +603.
  - **Integration:**
    - `Balances_include_a_converted_total_for_mixed_currencies`
    - `Converted_is_null_when_everyone_is_square`
    - `Converted_is_null_when_only_the_group_currency_is_used`
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Load `FxRate` and `ConvertedAmountMinor` in `BalanceQueries` alongside the existing projection.
- [ ] **Step 4:** Full ledger suite plus the OpenAPI update. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ledger): total balances in the group's currency`

### Task 10: Shared client logic and the web app

**Files:**
- Regenerate: `packages/api-client/src/schema.d.ts` (`pnpm --filter @kitty/api-client generate`)
- Modify: `packages/core/src/expense-form.ts`, `packages/core/src/errors.ts`. Create: `packages/core/src/fx.ts`. Export from `packages/core/src/index.ts`.
- Test: `packages/core/test/expense-form.test.ts`, `packages/core/test/fx.test.ts`
- Modify (web):
  - `apps/web/src/components/ExpenseForm.tsx`
  - `apps/web/src/app/groups/[id]/actions.ts` (adds `fetchRate`, and `fxRate`/`paidInGroupCurrency` in `saveExpense`/`recordSettlement`)
  - `apps/web/src/app/groups/[id]/page.tsx` (list amounts and the total card)
  - `apps/web/src/app/groups/[id]/settle/page.tsx`

**Interfaces:**
- Consumes: `parseRate`, `convertMinor` and `formatMoney` from `@kitty/money`; the regenerated API types.
- Produces (core):
  - `ExpenseFormState` gains `fxRate: string`: "" means "use the ECB rate / keep the saved one".
    - `toWrite` sends `fxRate: parseRate(fxRate)` only when the field is non-empty, and fails with `"fx_rate_invalid"` when it doesn't parse.
    - `editExpenseForm` starts with `fxRate: ""`.
  - `describeRate(o: { from: string; to: string; rate: string; rateDate: string | null; source: "ecb" | "manual" }): string`. Examples:
    - `"1 EUR = 19.1987 ZAR · ECB, 20 Nov 2026"`
    - `"1 EUR = 19.5 ZAR · entered by hand"`
  - `expenseAmounts(e: ExpenseDto, groupCurrency: string): string`. Examples:
    - `"€40.00 · R767.95"`
    - `"€40.00 · no rate yet"`
    - `"R120.00"` for the group's own currency
  - `errorMessage` texts for the three new codes (Global Constraints).
- [ ] **Step 1: Write failing core tests**
  - `toWrite omits fxRate when the field is empty`
  - `toWrite sends a canonical typed rate`
  - `toWrite rejects an invalid rate`
  - `describeRate ecb and manual`
  - `expenseAmounts in all three cases`
  - `errorMessage covers fx codes`
- [ ] **Step 2:** `pnpm --filter @kitty/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement core, then the web screens:
  - **Form:** when the currency differs from the group's, `fetchRate` runs on currency or date change (300 ms debounce). The form shows `describeRate` and the converted amount (`convertMinor`), with an "Edit rate" input bound to `fxRate`. When the fetch fails, the input is shown empty with a "Couldn't get the ECB rate" hint, and saving without it still works (the ledger saves with no rate). When editing, the form shows the saved rate (`describeRate` from the DTO) until the currency or date changes.
  - **Group page:** list rows use `expenseAmounts`. When `balances.converted` is non-null, an "About R… in total" card with each member's converted net, the note "Uses each expense's saved rate", and "N older expenses have no rate yet" when `excludedCount > 0`.
  - **Settle:** a foreign transfer gets a "Pay in ZAR instead" toggle that fetches today's rate (editable), shows the rand amount and sends `paidInGroupCurrency: true` with `fxRate` when the person edited it. A `fx_rate_required` answer shows the rate input.
- [ ] **Step 4:** `pnpm --filter @kitty/core test && pnpm --filter web typecheck && pnpm --filter web test && pnpm --filter web build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): exchange rates on expenses, totals and settling`

### Task 11: Mobile

**Files:**
- Modify:
  - `apps/mobile/src/components/ExpenseForm.tsx`
  - `apps/mobile/src/app/(app)/groups/[id]/index.tsx`
  - `apps/mobile/src/app/(app)/groups/[id]/settle.tsx`
- Test: `apps/mobile/test/expense-form.test.tsx`, `apps/mobile/test/group-home.test.tsx`, `apps/mobile/test/settle.test.tsx` (the fake ledger gains `GET /fx-rate`)

**Interfaces:**
- Consumes: everything Task 10 added to core and money. Behaviour is identical to web.
- [ ] **Step 1: Write failing tests**
  - `shows the ECB rate and converted amount for a foreign currency`
  - `saving without editing the rate sends no fxRate`
  - `an edited rate is sent`
  - `rate fetch failure still lets you save`
  - `group home shows the converted total card and hides it when null`
  - `settle pays a EUR debt in ZAR at the confirmed rate`
  - `settle shows the rate input after fx_rate_required`
- [ ] **Step 2:** `pnpm --filter mobile test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter mobile test && pnpm --filter mobile typecheck && pnpm --filter mobile export`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mobile): exchange rates on expenses, totals and settling`

### Task 12: Running pulse everywhere (Aspire, compose, CI)

**Files:**
- Modify: `aspire/Kitty.AppHost/AppHost.cs`
- Create: `services/pulse/Dockerfile`. Modify: `deploy/compose/docker-compose.yml`, `deploy/compose/.env.example`, `deploy/compose/RUNBOOK.md`
- Create: `deploy/compose/pulse-db-setup.sql`, modelled on `ai-db-setup.sql` (role `pulse` owning schema `pulse`)
- Create: `.github/workflows/pulse.yml`. Modify: `.github/workflows/images.yml`, `.github/dependabot.yml` (a `gomod` entry for `/services/pulse`, weekly, minor+patch grouped), `README.md`

**Interfaces:**
- **Aspire:**
  - `builder.AddExecutable("pulse", "go", "../../services/pulse", "run", "./cmd/pulse")`;
  - `.WithHttpEndpoint(env: "PULSE_PORT", name: "grpc")`;
  - `.WithEnvironment("PULSE_DATABASE_URL", ledgerDb.Resource.UriExpression)`;
  - `.WaitFor(ledgerDb)`;
  - the ledger gets `.WithEnvironment("Fx__Url", pulse.GetEndpoint("grpc")).WaitFor(pulse)`.
  - If `UriExpression` doesn't exist in Aspire 17, build the URL with `ReferenceExpression.Create` from the Postgres resource's host, port, user and password, and record a ruling.
- **Compose:**
  - service `pulse` on image `ghcr.io/<owner>/kitty-pulse:latest`;
  - healthcheck `["CMD", "/pulse", "-health"]`;
  - `PULSE_DATABASE_URL` uses the `pulse` role;
  - `pulse-db-setup` runs `pulse-db-setup.sql` like `ai-db-setup`;
  - the ledger gets `Fx__Url: http://pulse:5090` and `depends_on: pulse: condition: service_healthy`.
- **Dockerfile:** multi-stage `golang:1.27` build → `gcr.io/distroless/static-debian12:nonroot`, with `CGO_ENABLED=0` and an entrypoint of `/pulse`.
- **CI (`pulse.yml`):**
  - triggers on paths `services/pulse/**`, `contracts/proto/kitty/fx/**` and the workflow itself, plus `workflow_call`;
  - `actions/setup-go` pinned by SHA with `go-version-file: services/pulse/go.mod`;
  - steps: `go tool buf lint`, then `go tool buf generate && git diff --exit-code`, then `go vet ./...`, then `go test ./...`.
  - In `images.yml`: add `pulse-tests` to `needs`, and add a `kitty-pulse` matrix entry.
- [ ] **Step 1:** Make the changes.
- [ ] **Step 2: Verify locally**
  - `dotnet run --project aspire/Kitty.AppHost`: pulse is healthy and the ledger starts.
  - In the web app on a ZAR group: add a EUR expense dated last Saturday. It shows "ECB, <Friday>" and a rand amount.
  - Settle it in ZAR.
  - `docker compose -f deploy/compose/docker-compose.yml config` is valid.
- [ ] **Step 3:** Push the branch. Expected: pulse, ledger, web and android workflows all green.
- [ ] **Step 4: Commit** `ci(pulse): run pulse under Aspire and compose, test and publish its image`

## Self-review notes
- Spec coverage:
  - §3.1 → Tasks 1–4
  - §3.2 → Tasks 5–9
  - §3.3 → Tasks 10–11
  - §3.4 → Task 12
  - non-goals untouched
  - provenance (`FxRateDate` and `FxRateSource`) → Tasks 7–8
  - drift → Task 9
- Ruling recorded in Task 9: `converted` is also null when every row is in the group's currency.
