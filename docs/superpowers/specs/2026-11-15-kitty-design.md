# Kitty — shared expenses, without the paywall

Design doc · 2026-11-15 · status: draft for approval

## 1. Intent and why

Kitty is a free, open-source app for splitting shared costs between friends,
roommates, couples and travel groups. The market leader (Splitwise) capped free
users at about 4 new expenses per day in late 2023 and charges about $40/year
for Pro; its reviews are full of people looking for an alternative. Kitty is
that alternative, with two things the leader does badly: live itemized
receipt splitting at the table, and an AI that understands plain language.

It has two jobs at once, and both are real:

1. **A product people use weekly.** Roommates splitting rent and groceries,
   friends splitting dinner, groups splitting a trip.
2. **A job-hunting showcase.** The owner already has a polyglot project
   (community-alerts-platform: Next.js, Spring Boot, .NET worker, Python
   scikit-learn, RabbitMQ/LavinMQ, Neon, Upstash, SSE, Web Push, hand-rolled
   JWT, Terraform → Azure Container Apps, GitHub Actions). Kitty must **add**
   the in-demand skills that project does not show, not repeat it.

Skills Kitty adds (chosen from 2026 job-posting research): LLM integration
(vision, agents, RAG, MCP, evals), Kubernetes + GitOps, native mobile, event
streaming with Kafka + transactional outbox, WebSockets, standards-based auth
(OIDC/OAuth 2.1 + PKCE), OpenTelemetry observability, gRPC, Go, Testcontainers,
E2E and load testing, supply-chain security scanning.

Primary users: groups in South Africa, mobile-first. Default currency ZAR;
multi-currency for trips.

## 2. Goals, non-goals, anti-goals

**Goals**
- Unlimited expenses, no ads, free forever.
- Correct balances, always. Money is integers in minor units plus an ISO 4217
  currency code; no floats anywhere in the money path.
- Receipt photo → itemized lines → everyone at the table claims their items
  live on their own phone → tax/tip/service split proportionally.
- Plain-language expense entry ("paid R600 for petrol, split with Sam and Ana").
- "Ask Kitty" questions about the group's spending.
- An MCP server so Claude/ChatGPT can read balances and draft expenses.
- Every technology listed in §5 does a real job in the product.
- Runs at R0/month on free tiers and self-hosting.

**Non-goals**
- Moving money. Kitty never holds, sends or receives funds. "Settle up" shares
  the payee's payment details / a payment link and records a settlement when
  either party marks it paid.
- Bank account sync, credit scoring, budgeting beyond the group.
- Publishing to the iOS App Store (US$99/yr). See §7 for distribution.
- Monetization of any kind.
- Offline editing/deleting (owner decision). Launch is online-only; the API
  is offline-ready from day one (client-generated UUIDs + idempotency keys),
  and Phase 6 adds an offline **add-expense** queue on mobile ("saved, will
  sync"). Edits and deletes stay online-only to avoid sync conflicts.

**Anti-goals (failure even if it "works")**
- A balance that is wrong, or that changes when nobody edited anything.
- The AI writing to the ledger without the user confirming.
- Technology that is wired in but does nothing a user would notice or an
  engineer would need ("resume-driven" plumbing).
- A user seeing any data from a group they are not in, via any path
  (API, AI answer, MCP tool, notification).

## 3. Constraints

- **Free tiers only**, with self-hosting / emulators where no free tier exists.
  Verified limits as of 2026-11: Oracle Always Free A1 = 2 OCPU / 12 GB RAM
  (cut from 4/24 in June 2026; exceeding it disables instances). Gemini API
  free tier is Flash / Flash-Lite and embedding models only, rate limits
  unpublished and tight. Neon/Supabase free projects suspend when idle.
  CloudAMQP free = 20 queues. Upstash free Redis exists (limits vary by
  source).
- Every service must run fully offline-from-cloud locally (emulators +
  containers) so development costs nothing and needs no accounts.
- The owner must be able to explain every service line by line in an
  interview. Go and Kubernetes are new to them: keep the Go service small and
  the cluster setup conventional (Helm charts, no custom operators).
- No secrets in source. Environment / Kubernetes secrets only (sealed via
  SOPS or Sealed Secrets in git — builder's choice).

## 4. Approaches considered

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| A | **Fill the gaps**: Expo + Next.js, .NET ledger, Python AI, Go service, Kafka, Keycloak, k3s + Argo CD, OpenTelemetry | Most new skills, nothing repeats the last project; most work | **Chosen** by owner |
| B | Depth over breadth: TypeScript + Python only, modular monolith | Ships fastest, easiest to polish; shows few technologies | Rejected: works against the "as much in-demand tech as possible" goal |
| C | Reuse proven stack (Next/Spring/.NET/Python/RabbitMQ) + AI | Fastest, familiar; shows recruiters nothing new besides AI | Rejected: duplicates existing portfolio |

Risk mitigation for A: build in phases (§9) so a usable product is live
before the heavy infrastructure lands.

## 5. Architecture

```
 Expo app (iOS/Android)      Next.js web (PWA)
        │  REST + SignalR (WSS)      │
        └──────────────┬─────────────┘
                       ▼
              ┌──────────────────┐   OIDC (PKCE)   ┌──────────┐
              │ ledger  (.NET)   │◄───────────────►│ Keycloak │
              │ REST, SignalR    │                 └──────────┘
              │ EF Core, outbox  │──gRPC──►┌───────────────┐
              └──┬──────┬────────┘         │ pulse (Go)    │
     Postgres ◄──┘      │ outbox relay     │ FX rates gRPC │
     (+pgvector)        ▼                  │ recurring jobs│
     Redis ◄──── Kafka (Redpanda) ────────►│ notifications │
     Blob  ◄──┐   topics, Protobuf         └───────────────┘
              │         ▲ │
              │         │ ▼
              └──── ai (Python FastAPI) ── Gemini / Ollama
                    receipt vision, NL parse, RAG, agent, MCP server
```

### 5.1 Services

**ledger — C# / .NET 10 LTS, ASP.NET Core minimal APIs, EF Core, Postgres**
- Source of truth for users (mirrored from Keycloak `sub`), groups,
  memberships, invites, expenses, splits, receipts, item claims, settlements.
- REST API (OpenAPI document generated, used to generate the TypeScript
  client shared by web and mobile).
- SignalR hub for "table mode" (live item claiming) and live group updates;
  Redis backplane so it is correct with more than one replica.
- Writes require an `Idempotency-Key` header; replays return the stored
  response (key + response stored in Postgres for 24 h, Redis as fast path).
- Transactional outbox: every state change writes an event row in the same
  DB transaction; a background relay publishes to Kafka and marks it sent.
  At-least-once delivery; consumers dedupe by event id.
- Calls `pulse` over gRPC for FX rates.
- Rate limiting via ASP.NET Core rate limiter (Redis-backed partition per
  user).

**ai — Python 3.13, FastAPI**
- *Receipt parsing (owner decision: privacy-first hybrid):* consumes
  `receipt.uploaded`, fetches the image from blob, runs **PaddleOCR locally**
  (CPU, in the ai service) to get text, **redacts** card numbers (PAN
  patterns, "**** 1234"), cardholder/cashier names and phone numbers, then
  sends **only the redacted text** — never the image — to the LLM with a JSON
  schema for structured output (merchant, date, currency, line items with
  qty/price, tax, tip, service charge, total). Validates arithmetic (items +
  charges ≈ total within 1%), emits `receipt.parsed` or `receipt.failed`.
  If the LLM is rate-limited, the job goes to a retry topic with backoff and
  the client immediately offers manual item entry (table mode keeps working
  with hand-typed items; a late parse result is offered as a suggestion,
  never overwrites typed items). The privacy notice states that redacted
  receipt text is sent to Google's Gemini free tier. The ledger stores the result
  as a *draft*; nothing hits balances until a person confirms.
- *Natural-language entry:* `POST /parse-expense` returns a draft expense
  (amount, currency, payer, participants resolved against group members,
  split type). The client shows it for confirmation.
- *Ask Kitty (agent):* questions run as a tool-using agent whose tools are
  read-only ledger lookups (what I owe and am owed; a group's spending over a
  date range) executed **with the asking user's token**, so authorization is
  enforced by the ledger, not by the prompt. The ledger does the arithmetic and
  formats the money; the model only quotes it. No pgvector: every question the
  owner asks is an exact lookup (see the phase 4b design).
- *MCP server:* Streamable HTTP transport, OAuth via Keycloak. Tools:
  `list_groups`, `get_balances`, `list_expenses`, `draft_expense` (creates a
  draft the user must confirm in the app — anti-goal 2).
- *Model provider abstraction:* Gemini Flash (free) in cloud, Ollama
  locally / as fallback. Swappable by config.
- *Evals:* bootstrapped from public receipt datasets (CORD, SROIE) so Phase 2
  has something to measure; then a labelled set of ≥50 real receipts (mixed SA retailers and
  restaurants, photographed by the owner/friends, PII-scrubbed) and ≥100 NL
  phrases. A CI job reports line-item F1, total accuracy, and participant
  resolution accuracy; regressions beyond a threshold fail the job. Runs on
  demand / nightly (not every PR) to respect free-tier rate limits.
- Receipt text is untrusted input: the model gets it as data, outputs are
  schema-validated, and the parser has no tools.
- Memory note: PaddleOCR adds roughly 0.5–1 GB to the ai service; include it
  in the 12 GB budget (§7).

**pulse — Go**
- gRPC server: `GetRate(base, quote, date)` backed by a daily fetch from the
  Frankfurter API (ECB rates, free, no key, includes ZAR), cached in Redis,
  persisted in its own table for historical lookups.
- Recurring expenses: cron-style scheduler (e.g. rent on the 1st) that calls
  the ledger's API to create the expense (idempotency key = schedule id +
  period).
- Notifications: consumes ledger events, sends Expo push notifications and
  email (Resend free tier), respects per-user preferences.
- Kept deliberately small: three packages, standard library + gRPC + a Kafka
  client.

**web — Next.js (App Router), TypeScript**
- Full feature parity for groups, expenses, balances, settle up, Ask Kitty.
  Installable PWA. Table mode join via QR link works in the browser too, so
  friends without the app can still claim items.

**mobile — Expo (React Native), TypeScript**
- Same features, plus camera receipt capture and push notifications.
  Shared packages with web: API client, domain types, money formatting,
  split math previews.

**Keycloak**
- OIDC provider. Social login (Google) + email/password + passkeys. Mobile and
  web use Authorization Code + PKCE. Realm config exported to git and
  imported on boot.

### 5.2 Data and messaging
- **Postgres** (Neon in cloud — pgvector supported — or in-cluster;
  builder's choice per §8). EF Core migrations owned by ledger. `pulse` and
  `ai` own separate schemas.
- **Kafka API via Redpanda** (in-cluster; Aiven free Kafka as an option).
  Topics: `ledger.events` (keyed by group id for ordering), `receipt.uploaded`,
  `receipt.parsed`. Event payloads are **Protobuf**, registered in Redpanda's
  schema registry; the same `.proto` repo folder generates C#, Go and Python
  types (gRPC definitions live there too).
- **Redis** (Upstash in cloud, container locally): SignalR backplane,
  idempotency fast path, rate limits, FX cache.
- **Blob storage**: Azure Blob (Azurite locally). Receipts are uploaded via
  short-lived SAS URLs issued by the ledger; images are deleted 90 days
  after the expense is confirmed (privacy).

### 5.2a Members vs users (decided: builder's-check call)
- A **member** belongs to a group; a **user** is a Keycloak account. A member
  may have no user yet (a "placeholder" added by name, like "Gran"). Splits
  and balances reference members, never users.
- Placeholders are claimed by invite link: the invitee signs in and the
  placeholder's history becomes theirs.
- **Table-mode guests** join via QR without an account: they enter a display
  name and get a short-lived guest token scoped to *that one receipt session*
  (can see that receipt's items and claim them, nothing else). The host maps
  each guest to an existing member or creates a placeholder before locking.
  This is how anti-goal 4 holds for anonymous sessions.

### 5.3 Money rules (the part that must never be wrong)
- Amounts: `long` minor units + currency. Splits must sum exactly to the
  expense amount; remainders from division go to participants in a stable,
  documented order (e.g. sorted by member id) so results are deterministic.
- Split types: equal, exact amounts, percentages, shares, itemized (from
  receipt claims; unclaimed items split equally across participants, shared
  items split among claimers; tax/tip/service distributed proportionally to
  each person's subtotal).
- Each group has a base currency. A foreign-currency expense stores the
  original amount, currency, and the FX rate used (fetched at entry time,
  editable). Balances are kept per currency. The "converted total" view uses
  **each expense's stored rate** (never today's rate), so it only changes when
  someone edits something. Settling a foreign-currency debt in the base
  currency records a settlement with its own rate, shown to and confirmed by
  the payer at settle time; that rate is stored on the settlement. pulse's
  historical lookup exists to pre-fill the rate for back-dated expenses.
- Debt simplification: compute net balance per member per currency, then
  greedy max-creditor/max-debtor matching to produce at most n−1 transfers.
  Property-based tests: total owed = total due, simplification never changes
  anyone's net position.
- Edits and deletes are soft and audited (who, when, before/after); balances
  are always recomputed from the current non-deleted expenses and
  settlements, never stored as a mutable running total.

## 6. Features (user-visible)

1. Sign up / in (Google, email, passkey). Create a group, invite via link/QR.
2. Add expense manually: amount, payer(s), split type, category, date, note.
3. Balances per group and across groups; "simplify debts" view.
4. Settle up: show the payee's saved payment details (bank / PayShap ID /
   payment link text), copy-to-clipboard, mark paid → settlement recorded.
5. Receipt scan → draft itemized expense.
6. **Table mode**: host scans receipt, a QR appears; others join (app or
   browser) and tap items live; avatars appear on items in real time; host
   locks and confirms.
7. Plain-language entry with confirmation card.
8. Recurring expenses (rent, subscriptions).
9. Notifications: added to an expense, settled with, weekly "you owe"
   nudge (opt-in).
10. Ask Kitty chat.
11. MCP connector.
12. Multi-currency trips.
13. Fun: "Who pays?" roulette (weighted optionally by who owes most);
    year-end **Kitty Wrapped** per group (AI-written recap from aggregated
    stats, shareable image card).

## 7. Deployment and operations

- **Local**: .NET Aspire AppHost starts everything — ledger, ai (Python),
  pulse (Go), web (Node), Postgres+pgvector, Redis, Redpanda, Azurite,
  Keycloak, Ollama (optional) — and shows traces/logs/metrics in the Aspire
  dashboard. A `docker-compose.yml` mirror exists for people without the
  .NET SDK (builder may decide to generate it from Aspire).
- **Cloud (R0)**: one Oracle Always Free A1 VM (2 OCPU / 12 GB) running k3s.
  Helm chart per service in `deploy/charts`, Argo CD watches `deploy/` (GitOps).
  Ingress via Traefik (bundled with k3s) + cert-manager (Let's Encrypt).
  Cloudflare free for DNS/TLS proxy. Memory budget must fit 12 GB with
  headroom; if not, move Postgres to Neon and Redis to Upstash first.
- **Azure**: Terraform provisions the Azure Blob storage account (12-month
  free 5 GB; Cloudflare R2 free tier is the fallback after). Terraform also
  provisions the Oracle VM and network.
- **Container images**: GitHub Container Registry (free for public repos).
- **Observability**: OpenTelemetry SDKs in every service (traces, metrics,
  logs) → OpenTelemetry Collector in-cluster → Grafana Cloud free tier. One
  dashboard for business metrics (expenses/day, receipt parse success rate,
  p95 latency) and alerts on error rate.
- **CI/CD (GitHub Actions)**: path-filtered jobs per service: lint, unit
  tests, Testcontainers integration tests, build image, Trivy scan, push to
  GHCR, bump image tag in `deploy/` → Argo CD syncs. CodeQL, Dependabot,
  secret scanning on the repo. Playwright E2E against a Compose stack on PRs
  touching web/ledger. k6 load test on demand.
- **Mobile distribution**: Android APK via EAS Build (free tier) and direct
  download / Play internal testing; iOS testers via Expo Go or EAS
  development builds. The web PWA covers everyone else.

## 8. Decisions left to the builder

- Exact library choices within each service (e.g. Kafka client libraries,
  FastAPI structure, Go router), and versions (latest stable at build time).
- In-cluster vs managed for Postgres/Redis, as long as the 12 GB budget and
  R0 cost hold.
- Secrets tooling (SOPS vs Sealed Secrets).
- UI design system and visual direction (a separate design pass will set
  this; must be mobile-first and accessible).
- Whether `docker-compose.yml` is hand-written or generated.

## 9. Phases (each ends with something usable)

1. **Core ledger**: monorepo, Aspire, Keycloak, ledger API (groups, invites,
   placeholder members, expenses, all split types except itemized, balances,
   simplify, settle), web app for those flows, unit + Testcontainers tests, CI.
   **Interim deploy**: Docker Compose on the Oracle VM behind Caddy with a
   free DuckDNS hostname (a Cloudflare Tunnel needs a paid domain), so
   friends can use it from Phase 1 (replaced by k3s in Phase 5).
   Client-generated UUIDs for expenses from day one.
2. **Mobile + receipts + table mode**: Expo app, blob uploads, Kafka +
   outbox, ai receipt parsing, itemized split, SignalR table mode.
3. **pulse**: FX + multi-currency, recurring expenses, push/email
   notifications, gRPC.
4. **AI depth**: 4a NL entry, 4b Ask Kitty (agent over read-only lookups), 4c crossing
   things off by sentence (a payment linked to the expenses it covers; shipped as
   designed in `2026-11-26-kitty-phase4c-cross-off-design.md`, with Settle up ticks
   and a recent-payments list), 4d MCP server, 4e evals in CI.
5. **Production**: Terraform, k3s, Helm, Argo CD, OpenTelemetry → Grafana,
   security scanning, Playwright, k6.
6. **Fun + polish**: roulette, Kitty Wrapped, offline add-expense queue on
   mobile, onboarding, README with architecture diagram and a short demo video.

## 10. Success

- The owner's own friend group / household uses it instead of Splitwise for
  a month.
- A fresh clone runs end-to-end locally with one command.
- Every row in §5 can be demoed doing its real job in under 10 minutes.
- Balances pass property-based tests; receipt eval set reports ≥90% total
  accuracy.
