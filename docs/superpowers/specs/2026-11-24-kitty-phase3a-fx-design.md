# Kitty Phase 3a: pulse (Go), exchange rates and multi-currency, Design

Status: draft for owner approval. Builds on the [overall design](2026-11-15-kitty-design.md): §5.1 "pulse", §5.3
money rules, and §9 phase 3. Phase 3 is split like phase 2: **3a** exchange rates (this doc), **3b** recurring
expenses, **3c** notifications.

## 1. Intent

Groups on a trip spend in another currency. Kitty already records an expense in any of its 30 currencies and keeps
balances per currency, so a trip ends with "Sam owes you R450 **and** €20": there's no single total, and no way to pay
the euros back in rands. 3a fixes that:

- every foreign-currency expense and settlement stores the exchange rate to the group's currency, pre-filled from the
  ECB rate for its date and editable;
- balances show a total in the group's currency, worked out from those stored rates;
- a foreign debt can be settled in the group's currency at a confirmed rate.

It is also the portfolio piece for **Go and gRPC**: a small Go service, `pulse`, serves the rates over gRPC to the .NET
ledger. That is why the rates don't come straight from the ledger.

## 2. Goals, non-goals, anti-goals

**Goals**
- `pulse` (Go): a gRPC `GetRate`, ECB rates from Frankfurter, stored for historical lookups.
- The ledger stores a rate on each foreign expense and settlement, and adds a converted total to balances.
- Web and mobile: rate on the expense form, converted totals on balances, "pay in <group currency>" when settling.
- Runs locally under Aspire and in `deploy/compose`, with CI for the Go service.

**Non-goals**
- Currencies outside Frankfurter's 30 (the existing `contracts/currencies.json` list is exactly those). No crypto.
- Changing a group's base currency.
- Converting between two foreign currencies directly (a EUR debt settled in USD). Only foreign → group currency.
- Recurring expenses and notifications (3b, 3c). `pulse` gets its scheduler and Kafka consumer then, not now.

**Anti-goals (failure even if it works)**
- A balance or total that changes when nobody edited anything. Totals use each row's stored rate, never today's.
- Floats in the money path. Rates are decimals end to end (`numeric` in Postgres, `decimal` in C#, a decimal string in
  JSON and Protobuf, a decimal library in Go); converted amounts are integer minor units.
- Being unable to save an expense because the rate service is down. The person can always type the rate.
- Per-currency balances becoming less true. They stay the source of truth; the converted total is a view on top.

## 3. How it works

### 3.1 pulse (new: `services/pulse`, Go)
- gRPC service `kitty.fx.v1.Rates` in `contracts/proto/kitty/fx/v1/rates.proto`:
  `GetRate(GetRateRequest{base, quote, date}) → GetRateResponse{rate (decimal string), rate_date, source}`.
  `rate_date` is the ECB date actually used. Errors: `INVALID_ARGUMENT` (unknown currency, date before 1999-01-04),
  `UNAVAILABLE` (no stored rate and Frankfurter unreachable).
- Rates are stored once per ECB date as EUR→X for every currency (Frankfurter's base), in a `pulse` schema in the
  shared Postgres. Any pair is a cross rate: `rate(A→B) = EUR→B / EUR→A`, rounded to 10 decimal places (half-even).
  Same currency → `1`.
- Lookup for date D (a future date is treated as today): ECB doesn't publish on weekends and TARGET holidays, so a
  Saturday expense gets Friday's rate. pulse records which ECB date each *asked-for* date resolved to, and only ever
  answers from that record. The first time D is asked for, it fetches `GET /v1/{D}` (or `/v1/latest` for today) from
  Frankfurter, which returns the ECB date it used, E ≤ D; pulse stores E's rates and the mapping D → E. ("Latest stored
  date ≤ D" is not used: with only scattered dates stored it would hand out a months-old rate.) Today's mapping is
  refreshed by the daily fetch, since today's rate appears only after the ECB publishes.
- A daily fetch (16:30 UTC, after the ECB publishes, plus once at startup) keeps "today" warm. A plain ticker in the
  process; 3b brings the real scheduler.
- gRPC health service for Aspire and compose health checks. Plain HTTP/2 (h2c) inside the network; no auth (it's not
  exposed outside, and rates are public data).
- **Builder's call:** no Redis cache. The spec's Redis FX cache would save a single indexed read; not worth it.
- Packages: `cmd/pulse` (wiring), `internal/fx` (store, Frankfurter client, cross-rate math, gRPC server). Generated Go
  code from `buf generate`, committed, checked in CI.

### 3.2 ledger
- **Rates client:** `IFxRates.GetAsync(base, quote, date)` with a gRPC implementation (`Grpc.Net.ClientFactory`).
  Tests substitute a fake.
- **New endpoint** `GET /groups/{groupId}/fx-rate?currency=EUR&date=2026-11-20` → `{ rate, rateDate, source }` for the
  forms to pre-fill. `503 fx_rate_unavailable` if pulse can't answer.
- **Expenses:** new `FxRate` (`numeric(20,10)`), `FxRateDate` (the ECB date, null if typed) and `FxRateSource`
  (`ecb` | `manual`); all null when the currency is the group's. Write DTO gets optional `fxRate` (decimal string);
  read DTO gets `fxRate`, `fxRateDate`, `fxRateSource` and `convertedAmountMinor` (null when there's no rate).
  - **Sending a rate means the person typed it** (`manual`). The forms fetch the ECB rate only to show it, and leave
    `fxRate` out unless the person changed it.
  - Foreign currency, no `fxRate` sent → the ledger asks pulse for the rate at `occurredOn` and stores it as `ecb`.
  - **If pulse can't answer, the expense is still saved, without a rate** (anti-goal 3). It's left out of the
    converted total and counted in `excludedCount`; the expense list marks it "no rate yet", and editing it later
    fetches or takes one. This covers every path that creates expenses, including table-mode confirm, with no new UI
    there.
  - On edit, with no `fxRate` sent: the stored rate is kept unless the currency or date changed, or there was none;
    then it's fetched as above.
  - Validation: rate > 0, at most 10 decimal places, ≤ 1,000,000; must be absent when the currency is the group's.
- **Settlements:** new `FxRate`, `FxRateDate`, `FxRateSource` and `PaidInGroupCurrency` (bool). A foreign settlement
  **always** gets a rate, for the day it's recorded (settlements have no date field and can't be edited, so a missing
  rate could never be fixed): omitted → fetched from pulse; pulse down → `422 fx_rate_required`, and the settle page
  (which has a rate field anyway, for "pay in ZAR") asks for it. The settlement still reduces the
  *debt's* currency (`Currency`/`AmountMinor`), so per-currency balances behave exactly as today.
  `PaidInGroupCurrency` only records that the money changed hands in the group's currency, at `FxRate`; the read DTO
  gets `convertedAmountMinor` (what was actually paid).
- **Converting** (pure domain code, shared fixtures with TypeScript): `converted = round(amountMinor × rate × 10^(dq −
  db))` where `db`/`dq` are the currencies' minor-unit digits (JPY has 0). Rounding is half away from zero. For an
  expense, each payer and share is converted and the remainders are given out in member order (the same rule splits
  use) so converted payers and converted shares both sum exactly to the converted total.
- **Balances:** `BalancesDto` gains `converted: { currency, members[], transfers[], excludedCount }`: every non-deleted
  expense and settlement in the group's currency (rate 1 or its stored rate), simplified the same way. Rows with no
  stored rate (foreign expenses written before 3a) are left out and counted in `excludedCount`; editing one gives it a
  rate. The per-currency section is unchanged and stays what "settle up" suggests transfers from.
- **Drift (owner decision):** the converted total uses each row's own rate, so a foreign debt settled at a later rate
  can leave a small leftover in the total while the per-currency balance is square. That leftover is real
  exchange-rate drift and is shown, labelled "about". `converted` is `null` once every per-currency balance is zero
  (everyone is square, so there's nothing to total), and the card is hidden. Not chosen: matching each settlement to the
  expenses it pays off so the total always clears exactly — much more machinery for a few rand.
- Migration: add the columns (nullable). There's no production data yet (the Oracle VM isn't provisioned), so no
  backfill job.

### 3.3 Web and mobile (shared logic in `packages/core` / `packages/money`)
- **Expense form:** when the currency isn't the group's, show the rate line "1 EUR = R19.84 · ECB, 22 Nov" (fetched
  when the currency or date changes), an edit control for the rate, and the converted amount. If the rate can't be
  fetched, the field is empty and required.
- **Reopening an expense** shows its saved rate and where it came from ("ECB, 22 Nov" or "entered by hand"), not a
  fresh fetch.
- **Expense list:** foreign expenses show both amounts ("€40.00 · R793.60"), or "no rate yet".
- **Balances:** an "About R… in total" card above the per-currency sections when the group has more than one currency
  and `converted` isn't null, with a short note that it uses each expense's saved rate. `excludedCount > 0` shows "N older expenses have no rate yet".
- **Settle:** for a transfer in a foreign currency, a "Pay in ZAR instead" option shows the pre-filled rate (editable)
  and the rand amount; the payer confirms it before saving.
- Conversion previews in the clients use the same rounding as the ledger, pinned by `contracts/fixtures/fx.json`, which
  both the C# and TypeScript tests read (as `splits.json` already is).

### 3.4 Running it
- **Aspire:** pulse started from source (`go run ./cmd/pulse`) with the Postgres connection, an HTTP/2 endpoint, and
  `WaitFor(postgres)`; the ledger gets `Fx__Url` and `WaitFor(pulse)`.
- **Compose:** a `pulse` service from a distroless image built by the existing `images` workflow; the ledger depends on
  it being healthy.
- **CI:** `pulse.yml`, path-filtered: `buf` lint and a check that generated code is current, `go vet`, `go test` (store
  tests against Postgres via Testcontainers).

## 4. Approaches considered
1. **pulse serves rates over gRPC (chosen).** The design's plan; gives Go and gRPC a real job.
2. Ledger calls Frankfurter itself. Simplest, but no Go and no gRPC: drops the reason pulse exists.
3. pulse publishes rates to Kafka and the ledger keeps a copy. No gRPC, and the ledger already shows Kafka.

## 5. New dependencies (owner approval needed)
- Go toolchain (installed with winget). Go modules: `google.golang.org/grpc`, `google.golang.org/protobuf`,
  `github.com/jackc/pgx/v5`, `github.com/shopspring/decimal`, `github.com/testcontainers/testcontainers-go` (tests).
  `buf` runs via `go run` (pinned), no global install.
- .NET: `Grpc.Net.ClientFactory` (pulls `Grpc.Net.Client`). `Grpc.Tools` and `Google.Protobuf` are already in use;
  the ledger's `<Protobuf>` item generates clients for `kitty/fx` (today it's `GrpcServices="None"` for everything).

## 6. Left to the builder
- Table and column names in the `pulse` schema; schema creation on startup vs a migrations tool (keep it small).
- Exact UI copy and layout, within the existing screens' style.
- How the expense form debounces rate fetches.
