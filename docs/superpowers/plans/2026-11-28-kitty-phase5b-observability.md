# Kitty Phase 5b: OpenTelemetry to Grafana Cloud — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Kitty service sends scrubbed traces, metrics and logs through one in-cluster OpenTelemetry Collector to Grafana Cloud, with one dashboard and five email alerts kept as Terraform.

**Architecture:** Part A (Tasks 1–12) is repo work proven by unit tests, CI (including a Collector scrubbing test and the k3d run) and locally in the Aspire dashboard. Part B (Tasks 13–15) is the server: the owner's Grafana Cloud account and sealed token, the Terraform apply, each alert proven once, and the client-address check. Every Part B step that changes the server, Grafana Cloud or data is confirmed with the owner.

**Tech Stack:** OpenTelemetry Collector contrib (Helm chart `open-telemetry/opentelemetry-collector` 0.183.2), OpenTelemetry SDKs for .NET (existing), Python, Go and Node (`@vercel/otel`), Grafana Cloud OTLP gateway, Terraform `grafana/grafana` 4.55.0, pytest, xUnit, Go test, vitest.

**Spec:** `docs/superpowers/specs/2026-11-28-kitty-phase5b-observability-design.md`

## Global Constraints

- No personal data leaves the server: drop bodies, headers (except `content-type`, `user-agent`), `url.query` and query parts, `db.statement` values (keep operation + table), `enduser.*`, client addresses (`client.address`, `ClientHost`, `X-Forwarded-For`, `network.peer.address`), raw paths/URLs (`url.path`, `url.full`, `RequestPath`, `http.target`), keys containing `token|password|secret|authorization|cookie|email`; mask emails, JWTs (`eyJ…`), `Bearer …`, Gemini keys (`AIza…`, `AQ.…`), 16-letter app passwords and invite tokens in values and log bodies.
- Telemetry never breaks or slows Kitty: async batch export, bounded queues, drop on failure; no endpoint set = no exporter.
- Grafana Cloud free tier, no payment method; budget under 3k metric series, under 2 GB logs and 2 GB traces a month. No user/group ids, raw paths or amounts as metric labels.
- Services read only standard `OTEL_*` variables. Production: `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.observability:4318`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, `OTEL_SERVICE_NAME=<ledger|ai|pulse|web>`, `OTEL_LOGS_EXPORTER=none`.
- Metric names exactly: `kitty.expenses.created{split_type}`, `kitty.receipts.read{outcome}`, `kitty.sentences.parsed{outcome}`, `kitty.model.calls{kind,result}`, `kitty.notifications.sent{channel,result}`, `kitty.recurring.added`, `kitty.backup.last_success` (Unix seconds), `kitty.backup.size_bytes`.
- Alerts exactly: 5xx > 5% over 10 min with ≥ 20 requests; a pod crash-looping or not ready 10 min; no backup for 26 h; certificate expiring < 14 days; Collector silent 15 min.
- New dependencies only: the OTel SDK + OTLP exporter + named instrumentations per service, the Collector chart, the Grafana provider. Pinned. No operator, no auto-injection.
- The builder never sees Grafana tokens, the Gemini key or the SMTP password; the owner seals them.
- Ledger outbox: one nullable column `trace_parent` (text), filled for every row; EF migration applied on start. Protobuf contracts unchanged.
- Docker-based tests (ledger integration, ai worker, pulse store) need Docker Desktop running on the PC; ask the owner to start it at Task 3, else they run in CI only and the ledger says so.
- Conventional commits; no Claude attribution.

## Review Focus

1. **Grafana Cloud unreachable or the token wrong:** Kitty answers as fast as before; data is dropped. Pinned by Task 11's blackhole-exporter run.
2. **The Collector down entirely:** services keep working, exports fail quietly. Pinned by Task 11's "Collector scaled to 0" smoke run.
3. **A log line carrying an email, token or invite path** (Keycloak events, ai parse logs, Traefik access log): masked before export. Pinned by Task 1's scrub fixtures.
4. **Scanners hitting random URLs:** no new metric series per raw path (`http.route` only templated or absent; `url.path` dropped). Pinned by Task 1's cardinality fixture.
5. **The Collector unreachable when the nightly backup reports:** the backup still succeeds and says why the report failed. Pinned by Task 8's test.

---

## Part A — in the repo

### Task 1: The Collector — chart values and the scrubbing test

**Files:**
- Create: `deploy/values/production/otel-collector.yaml`, `deploy/observability/scrub-test/{config.yaml,dirty-traces.json,dirty-logs.json,dirty-metrics.json,check.py}`, `deploy/tests/test_otel_collector.py`
- Modify: `deploy/apps/values.yaml`, `deploy/apps/templates/applications.yaml` (Application `otel-collector`, upstream chart 0.183.2, namespace `observability`), `.github/workflows/deploy.yml` (job `scrub`)

**Interfaces:**
- Produces: Service `otel-collector.observability` on 4317/4318; the processors `memory_limiter`, `k8sattributes`, `redaction/kitty`, `transform/kitty`, `attributes/kitty`, `filter/noise`, `batch` defined under `config.processors` in the values file (the scrub test reads them from there: one source); env `GRAFANA_OTLP_ENDPOINT`, `GRAFANA_OTLP_INSTANCE_ID`, `GRAFANA_OTLP_TOKEN` from Secret `grafana-cloud`; exporter `otlphttp/grafana` with `basicauth/grafana`.
- Values: `mode: daemonset`; image `otel/opentelemetry-collector-contrib` (tag pinned to the chart's appVersion 0.165.0); presets `logsCollection` (with `includeCollectorLogs: false`), `kubeletMetrics`, `kubernetesAttributes`; a `k8s_cluster` receiver and `prometheus` receiver (cert-manager `:9402/metrics`, Traefik `:9100/metrics`, and the Collector's own `:8888/metrics`, so `otelcol_exporter_sent_*` reaches Grafana for the "collector silent" alert) added in `config`; resources limit 256Mi; pipelines traces/metrics/logs all ending in `otlphttp/grafana`.

- [ ] **Step 1: Write the failing tests** (`test_otel_collector.py`, rendering `deploy/apps` and the values file):
  - `test_collector_application_is_pinned`: Application `otel-collector`, chart `opentelemetry-collector`, `targetRevision: 0.183.2`, namespace `observability`, valueFiles points at the production values.
  - `test_every_pipeline_scrubs_before_export`: for traces, metrics and logs, the processor list contains `memory_limiter` first, `redaction/kitty` (or `transform/kitty`) before `batch`, and the exporter is `otlphttp/grafana`.
  - `test_grafana_credentials_come_from_the_secret`: the three `GRAFANA_*` env vars use `secretKeyRef` `grafana-cloud`; no literal URL with credentials.
  - `test_memory_limit`: 256Mi.
- [ ] **Step 2: Write the scrubbing test** (`deploy/observability/scrub-test/`): `config.yaml` builds an `otlp` receiver → the processors copied verbatim by `check.py` from the values file → a `file` exporter. `dirty-*.json` are OTLP/JSON payloads containing: a span with `url.full=https://h/api/invites/abc123/join?x=1`, `url.query`, `client.address`, `http.request.header.authorization=Bearer eyJ…`, `db.statement=SELECT * FROM expenses WHERE description='Pizza with bob@x.com'`, `enduser.id`; a log body `user bob@example.com signed in with token eyJhbGciOi…` and a Traefik access-log record with `ClientHost`, `RequestPath=/invite/abc123`; a metric with `url.path=/random/123` and `http.route=/groups/{groupId}/expenses`. `check.py` asserts the exported file contains none of: `bob@`, `eyJ`, `Bearer`, `abc123`, `ClientHost`, `client.address`, `url.query`, `url.full`, `url.path`, `RequestPath`, `Pizza`, `enduser.`; and that `http.route=/groups/{groupId}/expenses`, `db.operation`/table name, status codes survive.
- [ ] **Step 3:** Run tests and the scrub job locally if Docker is up (`docker run otel/opentelemetry-collector-contrib:0.165.0 --config …`), else in CI. Expected: FAIL (no values file).
- [ ] **Step 4:** Write the values file and the Application.
- [ ] **Step 5:** Run. Expected: PASS; `validate.sh` clean (the upstream chart is rendered via the apps chart only; add `helm template` of the upstream chart with these values to `validate.sh`).
- [ ] **Step 6: Commit** `feat(deploy): opentelemetry collector with scrubbing, and its scrub test`.

### Task 2: Kitty's charts point at the Collector

**Files:** Modify `deploy/charts/{kitty-ledger,kitty-web,kitty-ai,kitty-pulse}/templates/deployment.yaml` and their `values.yaml` (`otel.endpoint`, default `""` = off); `deploy/values/production/kitty-*.yaml` (`otel.endpoint: http://otel-collector.observability:4318`). Test: `deploy/tests/test_kitty_charts.py`.

**Interfaces:** Produces env on each main container: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, `OTEL_SERVICE_NAME` (`ledger|web|ai|pulse`), `OTEL_LOGS_EXPORTER=none`, `OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production`. Rendered only when `otel.endpoint` is set.

- [ ] **Step 1:** Tests `test_otel_env_in_production` (all four, exact values) and `test_no_otel_env_without_endpoint` (`--set otel.endpoint=`). Update `test_env_names_match_compose` to allow the five `OTEL_*` names.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): kitty services send telemetry to the collector`.

### Task 3: Ledger — trace context through the outbox, the expenses counter

**Files:**
- Modify: `services/ledger/src/Kitty.Ledger/Data/Entities/OutboxMessage.cs` (`public string? TraceParent { get; set; }`), `Infrastructure/Messaging/Outbox.cs` (`Add` sets `TraceParent = Activity.Current?.Id` when the current activity uses W3C format), `Infrastructure/Messaging/OutboxRelay.cs` (adds Kafka header `traceparent` when set), the expense-creation path in `Features/Expenses/ExpenseEndpoints.cs` (counter), `aspire/Kitty.ServiceDefaults/Extensions.cs` (`AddMeter("Kitty.Ledger")`, `AddSource("Kitty.Ledger")`, honour `OTEL_LOGS_EXPORTER=none`)
- Create: `Infrastructure/Telemetry/LedgerMetrics.cs` (`Meter("Kitty.Ledger")`, `Counter<long> ExpensesCreated` named `kitty.expenses.created`, tag `split_type` lower-case enum name), EF migration `AddOutboxTraceParent` (column `trace_parent text null`)
- Test: `tests/Kitty.Ledger.UnitTests/OutboxTraceTests.cs`, `tests/Kitty.Ledger.IntegrationTests/OutboxTests.cs`, `tests/Kitty.Ledger.IntegrationTests/MetricsTests.cs`, `KafkaProbe` (expose headers)

- [ ] **Step 0:** Ask the owner to start Docker Desktop (the ledger's integration tests use Testcontainers). Ledger the answer.
- [ ] **Step 1: Failing tests:**
  - unit `Add_records_the_current_trace`: inside an `Activity` started with W3C id, `Outbox.Add` (against an in-memory `DbContext` or captured entity) sets `TraceParent == activity.Id`; outside any activity it is null.
  - integration `Receipt_upload_message_carries_traceparent`: confirming a scan upload publishes `receipt.uploaded` whose Kafka headers include `traceparent` equal to the row's value and to the request's trace id.
  - integration `Expense_create_counts_once`: a `MeterListener` on `Kitty.Ledger` sees `kitty.expenses.created` += 1 with `split_type=equal` for one equal-split expense.
  - integration `Old_outbox_rows_without_trace_still_publish`: a row inserted with `TraceParent = null` is sent, no header.
  - integration `Parsed_result_continues_the_upload_trace`: a `receipt.parsed` message with a `traceparent` header is handled by the ledger's consumer inside a span whose trace id equals the header's (the consumer extracts it; spec §5.2 "its result message carries it back to the ledger").
- [ ] **Step 2:** Run `dotnet test services/ledger` (Aspire stopped). Expected: FAIL.
- [ ] **Step 3:** Implement; generate the migration with `dotnet ef migrations add AddOutboxTraceParent` (check it only adds the nullable column).
- [ ] **Step 4:** Run. Expected: PASS, whole ledger suite.
- [ ] **Step 5: Commit** `feat(ledger): carry trace context through the outbox and count expenses` (migration in the same commit).

### Task 4: ai — telemetry setup, Kafka trace continuation, counters

**Files:**
- Create: `services/ai/src/kitty_ai/telemetry.py`: `setup_telemetry(app: FastAPI) -> None` (no-op without `OTEL_EXPORTER_OTLP_ENDPOINT`; else tracer + meter providers with OTLP/HTTP exporters, FastAPI/httpx/psycopg instrumentation, Python logging bridged only if `OTEL_LOGS_EXPORTER` != `none`); `meter()`; `counters` object with `receipts_read`, `sentences_parsed`, `model_calls`; `extract_context(headers: list[tuple[str, bytes]] | None) -> Context`; `inject_headers(ctx) -> list[tuple[str, bytes]]`.
- Modify: `pyproject.toml` (+ `opentelemetry-sdk`, `opentelemetry-exporter-otlp-proto-http`, `opentelemetry-instrumentation-fastapi`, `-httpx`, `-psycopg`, pinned; `uv lock`), `main.py` (call `setup_telemetry`), `receipts/worker.py` (`_handle(value, headers)`: span `receipt.read` in the extracted context; `_retry_later` keeps `traceparent` alongside `NOT_BEFORE`; `_publish` injects it; counter `receipts_read.add(1, {"outcome": "parsed" | Reason.Name(r).lower()})`), plain-language entry route (`sentences_parsed{outcome}`), the model client wrappers (`model_calls{kind: receipt|sentence|ask, result: ok|rate_limited|error}`).
- Test: `tests/test_telemetry.py` (in-memory exporters/readers, no Docker), `tests/test_worker.py` (Docker: retry keeps the header).

- [ ] **Step 1: Failing tests:** `test_no_endpoint_means_no_exporter`; `test_extract_and_inject_round_trip` (a `traceparent` header → context → headers with the same trace id); `test_receipt_outcome_is_counted` (InMemoryMetricReader: one parsed + one `RATE_LIMITED` → two data points with those outcomes, no other labels); `test_read_span_is_child_of_upload` (a fake message with a `traceparent` header handled → finished span `receipt.read` has that trace id); Docker: `test_retry_keeps_traceparent`.
- [ ] **Step 2:** Run `uv run pytest`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the whole suite + `ruff`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ai): opentelemetry, receipt traces across kafka, and counters`.

### Task 5: pulse — telemetry setup and counters

**Files:**
- Create: `services/pulse/internal/telemetry/telemetry.go`: `Setup(ctx context.Context, service string) (shutdown func(context.Context) error, err error)` (no-op shutdown without `OTEL_EXPORTER_OTLP_ENDPOINT`; else OTLP/HTTP trace + metric providers, global propagator W3C); `Counters` with `NotificationsSent metric.Int64Counter` (`kitty.notifications.sent`, attrs `channel` email|push, `result` sent|failed) and `RecurringAdded` (`kitty.recurring.added`).
- Modify: `cmd/pulse/main.go` (Setup first, deferred shutdown; gRPC server with `otelgrpc.NewServerHandler()`; ledger gRPC client with `otelgrpc.NewClientHandler()`), `internal/notify/dispatch.go` (count each delivery), `internal/recurring` (count each period added), `go.mod`.
- Test: `internal/telemetry/telemetry_test.go`, additions in `internal/notify` and `internal/recurring` tests using `sdkmetric.NewManualReader()`.

- [ ] **Step 1: Failing tests:** `TestSetupWithoutEndpointIsNoop`; `TestDeliveryIsCounted` (one email sent, one push failed → two points with exactly those attributes); `TestRecurringAddIsCounted`.
- [ ] **Step 2:** `go test ./...`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `go build ./... && go vet ./... && go test ./...`. Expected: PASS (Docker tests need Docker Desktop).
- [ ] **Step 5: Commit** `feat(pulse): opentelemetry and notification counters`.

### Task 6: web — server-side tracing

**Files:** Create `apps/web/src/instrumentation.ts` (`export function register()` calling `registerOTel({ serviceName: process.env.OTEL_SERVICE_NAME ?? "web" })` only when `process.env.OTEL_EXPORTER_OTLP_ENDPOINT` is set and `process.env.NEXT_RUNTIME === "nodejs"`); test `apps/web/src/instrumentation.test.ts`; `apps/web/package.json` (+ `@vercel/otel`, `@opentelemetry/api`, pinned).

- [ ] **Step 1:** Failing tests (vitest, `vi.mock("@vercel/otel")`): `registers with the service name when an endpoint is set`; `does nothing without an endpoint`; `does nothing on the edge runtime`.
- [ ] **Step 2:** `pnpm --filter web test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter web typecheck && pnpm --filter web test && pnpm --filter web build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): server-side opentelemetry`.

### Task 7: Aspire — every service reports to the dashboard locally

**Files:** Modify `aspire/Kitty.AppHost/AppHost.cs` (`.WithOtlpExporter()` on `pulse`, `ai`, `web`; the ledger already has it).

- [ ] **Step 1:** Start Aspire (Docker Desktop up), upload a receipt photo in the web app, add an expense, type a sentence.
- [ ] **Step 2:** Expected in the Aspire dashboard: traces from all four services; one trace containing the upload request (ledger), the outbox publish, `receipt.read` (ai) and the result handling (ledger); metrics `kitty.expenses.created`, `kitty.receipts.read`, `kitty.sentences.parsed`.
- [ ] **Step 3:** Stop Aspire. **Commit** `feat(aspire): every service sends telemetry to the dashboard`.

### Task 8: backup.sh reports its last success

**Files:** Modify `deploy/compose/backup.sh`; test `deploy/tests/test_scripts.py`.

**Interfaces:** In `k3s` mode only, after a successful backup: `report_backup <name> <bytes>` finds the Collector's cluster IP (`kubectl -n observability get svc otel-collector -o jsonpath='{.spec.clusterIP}'`) and `curl -fsS -m 10 -X POST -H 'Content-Type: application/json' http://<ip>:4318/v1/metrics` with an OTLP/JSON body holding gauges `kitty.backup.last_success` (now, seconds) and `kitty.backup.size_bytes`, resource `service.name=kitty-backup`. On any failure: `echo "… backup ok, but reporting it failed: <reason>"` and exit 0.

- [ ] **Step 1:** Failing tests: `test_backup_reports_last_success` (stub curl receives a JSON body with both metric names and `service.name` `kitty-backup`); `test_backup_succeeds_when_reporting_fails` (Review Focus 5: stub curl exits 7 → backup exit 0, output says reporting failed); `test_compose_mode_does_not_report`.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `feat(deploy): the nightly backup reports its last success`.

### Task 9: Traefik's access log and metrics

**Files:** Modify `deploy/charts/kitty-edge/templates/cluster.yaml` (HelmChartConfig: the access-log and Prometheus-metrics keys that Traefik chart 41.6 honours — read the chart's `values.yaml` from the k3s static chart or its source and use exactly those keys; metrics on port 9100), test `deploy/tests/test_edge_chart.py`.

- [ ] **Step 1:** Failing test `test_traefik_config` extended: access log on (exact 41.6 key), Prometheus metrics entrypoint 9100.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS). Ledger the chart key and where it was read from.
- [ ] **Step 5: Commit** `fix(deploy): traefik access log and metrics with keys its chart honours`.

### Task 10: Grafana dashboard and alerts as Terraform

**Files:** Create `deploy/terraform/grafana/{versions.tf,backend.tf,variables.tf,folder.tf,dashboard.tf,dashboards/kitty.json,alerts.tf,contact.tf,terraform.tfvars.example,.gitignore}`; test `deploy/tests/test_grafana_terraform.py`; `.github/workflows/deploy.yml` (fmt + validate this folder too).

**Interfaces:** Variables: `grafana_url`, `grafana_token` (sensitive), `alert_email` (sensitive), `prometheus_datasource_uid`, `loki_datasource_uid`. Backend `oci`, bucket `kitty-tfstate`, key `grafana/terraform.tfstate`. Resources: `grafana_folder.kitty`, `grafana_dashboard.kitty` (`file("dashboards/kitty.json")`), `grafana_contact_point.owner` (email), `grafana_notification_policy.kitty`, `grafana_rule_group.kitty` with five rules named `error-rate`, `pod-unhealthy`, `backup-missing`, `certificate-expiring`, `collector-silent`.

- [ ] **Step 1:** Failing tests: `test_five_alerts_with_spec_thresholds` (each rule present; its expression text contains the thresholds `0.05`/`20`/`10m`, `26h` (93600 s), `14` days (1209600 s), `15m`); `test_dashboard_has_the_panels` (`kitty.json` parses; panel titles include "Expenses per day", "Receipt read success rate", "p95 response time", "Error rate", "Pod memory", "Pod restarts", "Last backup", "Certificate days left"); `test_no_personal_values_committed` (no `@` address, no token, `.gitignore` covers `terraform.tfvars`, `*.tfstate*`, `.terraform/`, `backend.hcl`).
- [ ] **Step 2–4:** Run (FAIL), write the Terraform and the dashboard JSON (queries on the metric names in Global Constraints), `terraform fmt -check`, `terraform init -backend=false && terraform validate`, tests (PASS).
- [ ] **Step 5: Commit** `feat(deploy): grafana dashboard and alerts as terraform`.

### Task 11: Sealing the Grafana token, and the k3d run with the Collector

**Files:** Modify `deploy/k3s/seal-env.sh` (`--grafana`: reads `GRAFANA_OTLP_ENDPOINT`, `GRAFANA_OTLP_INSTANCE_ID`, `GRAFANA_OTLP_TOKEN` from the env file; Secret `grafana-cloud` in namespace `observability`); `deploy/tests/test_seal_env.py`; `deploy/tests/k3d-e2e.sh`; `deploy/tests/ci-values-otel.yaml` (exporter → `debug` with `verbosity: detailed` instead of Grafana; no secret needed).

- [ ] **Step 1:** Failing tests: `test_grafana_secret_has_exactly_three_keys` (`--grafana --plain`); `test_grafana_missing_key_is_refused_by_name`.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5:** k3d-e2e: install the Collector (upstream chart, production values + `ci-values-otel.yaml`) before Kitty's charts; Kitty's charts with `otel.endpoint` set. After the smoke checks: the Collector's log contains a span from `service.name=ledger` with `k8s.namespace.name=kitty`, and contains none of `client.address`, `url.full`, `Bearer`.
- [ ] **Step 6 (Review Focus 1):** upgrade the Collector with its exporter pointed at `http://10.255.255.1:4318` (unroutable); smoke checks pass, and the median response time of 20 `/api/health` calls stays under 2× the earlier median.
- [ ] **Step 7 (Review Focus 2):** scale the Collector DaemonSet to 0 (`nodeSelector` patch); smoke checks pass.
- [ ] **Step 8:** Push; CI's k3d job green. **Commit** `feat(deploy): seal the grafana token; k3d run checks the collector`.

### Task 12: Runbook

**Files:** Modify `deploy/k3s/RUNBOOK.md` (section "Observability": where telemetry goes, what is scrubbed, the Grafana Cloud account and tokens, `seal-env.sh --grafana`, Terraform for Grafana, the five alerts and what to do for each, checking client addresses with `kubectl -n kube-system logs deploy/traefik`).

- [ ] **Step 1:** Write it, commands copied from the scripts. **Commit** `docs(deploy): observability runbook`.

**Then:** whole-branch review (executing-plans' final review), its fix pass, push, PR (draft until CI is green). Ask the owner to merge.

---

## Part B — on the server and in Grafana Cloud (confirm each changing step with the owner)

### Task 13: Grafana Cloud and the sealed token

- [ ] **Step 1 (owner):** create a free Grafana Cloud account (no payment method) and a stack in the region nearest South Africa; create an OTLP write token (Cloud portal → stack → OpenTelemetry → "Configure") and a service-account token with Editor on the stack. Add `GRAFANA_OTLP_ENDPOINT`, `GRAFANA_OTLP_INSTANCE_ID`, `GRAFANA_OTLP_TOKEN` to the server's `.env` (nano, as before).
- [ ] **Step 2 (owner, on the server):** `deploy/k3s/seal-env.sh deploy/compose/.env --grafana > ~/grafana-cloud.yaml`; the builder checks it is a SealedSecret with three keys and commits it to `deploy/secrets/production/` (the `kitty-secrets` Application covers the folder; the SealedSecret names namespace `observability`).
- [ ] **Step 3:** After the merge syncs: the Collector pod Ready; in Grafana Cloud's Explore, traces from all four services, logs from namespace `kitty`, metrics `kitty_expenses_created_total` etc. Expected: no blocked fields when searching for `@`, `eyJ`, `/invite/`.

### Task 14: Dashboard and alerts applied, each alert proven

- [ ] **Step 1 (confirm):** write `deploy/terraform/grafana/terraform.tfvars` on the PC (token and email typed by the owner or copied by them; never printed), `terraform init -backend-config=backend.hcl`, `plan` (only creates), `apply`.
- [ ] **Step 2 (confirm each):** prove every alert fires once and emails the owner, then recovers:
  - `pod-unhealthy`: scale `edge-deny` to a non-existent image tag for 11 minutes, then revert (Kitty unaffected: it only answers 404s).
  - `backup-missing`: temporarily set the rule's threshold to 60 s in a throwaway local apply, observe, restore (no fake data sent).
  - `certificate-expiring`, `error-rate`, `collector-silent`: Grafana's rule "Test" against live data with a temporarily lowered threshold, observe the email, restore.
- [ ] **Step 3:** Grafana Cloud's usage page: series, logs and traces well within §6's budget. Record numbers.

### Task 15: Client addresses (5a's open item)

- [ ] **Step 1:** From the owner's PC request the site; `kubectl -n kube-system logs deploy/traefik | tail` on the server: classify the client address as real or internal (never printed).
- [ ] **Step 2 (confirm, only if internal):** set Traefik to `hostPort` 80/443 in the HelmChartConfig (a PR), recheck.
- [ ] **Step 3:** Update the memory note (Grafana Cloud stack, tokens sealed, alerts live, client addresses verified).
