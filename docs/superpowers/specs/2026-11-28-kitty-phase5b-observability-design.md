# Kitty Phase 5b: OpenTelemetry to Grafana Cloud (design)

Status: design, 2026-11-28. Parent design: `2026-11-15-kitty-design.md` §7 ("Observability") and §9 item 5. Builds on
Phase 5a (`2026-11-27-kitty-phase5a-k3s-design.md`): Kitty runs on k3s, deployed by Argo CD from `deploy/`.

## 1. Intent

Kitty is live for friends on one free server. Today nothing tells the owner when it breaks: not a failing service, not a
crash-looping pod, not a missed backup, not a certificate that failed to renew. And the one service with telemetry (the
ledger, through its Aspire defaults) sends it nowhere in production.

Phase 5b makes Kitty observable the standard way: OpenTelemetry in every service → one OpenTelemetry Collector in the
cluster → Grafana Cloud's free tier, with one dashboard and a few alerts that email the owner.

Why: both of Kitty's jobs (parent §1). For the product, the owner hears about trouble before friends do. For the
showcase, OpenTelemetry across four languages (.NET, Python, Go, TypeScript), with a trace that follows a receipt from
upload through Kafka to the AI and back, is one of the skills Kitty exists to add (parent §1, "OpenTelemetry
observability"). The owner must be able to explain every line, so the pieces are the upstream, vendor-neutral ones.

## 2. Agreed with the owner

- **Grafana Cloud's free tier** is where telemetry goes, not a self-hosted stack (which would cost 2–3 GB of the ~7 GB
  free and four more systems).
- **Scrubbed:** telemetry leaves the server, so personal data is removed before it does (§5.4).
- **Approach 1** (§4): the upstream OpenTelemetry Collector, the official SDK in each service, and the dashboard and
  alert rules as Terraform code (Grafana's provider). Not Grafana Alloy, not the OpenTelemetry Operator.
- Split like 5a: Part A in the repo (proven in CI and locally against the Aspire dashboard), Part B on the server.
  The owner creates the Grafana Cloud account and its tokens; the builder can't.

## 3. Goals, non-goals, anti-goals

**Goals**
- Every service (ledger, ai, pulse, web) sends traces and metrics over OTLP; their logs reach Grafana Cloud too.
- Locally, the same telemetry shows up in the Aspire dashboard with no Grafana account (parent §3: everything runs
  offline-from-cloud locally).
- **One trace per receipt:** a photo's upload (ledger), its Kafka hop, the AI's parse, and the result's way back show as
  one trace (W3C trace context carried in Kafka message headers).
- **Business numbers, counted in code:** expenses added; receipts read, by outcome (parsed / each failure reason);
  sentences understood (plain-language entry), by outcome. No user or group identifiers as labels.
- **One dashboard, "Kitty"**: expenses per day, receipt read success rate, p95 response time per service, error rate per
  service, pod memory against limits and restarts, last backup age, certificate days left.
- **Alerts, by email to the owner:**
  1. error rate: more than 5% of a service's requests answer 5xx over 10 minutes (with at least 20 requests);
  2. a pod crash-looping or not ready for 10 minutes;
  3. no successful nightly backup for 26 hours;
  4. the HTTPS certificate expiring in under 14 days (a failed renewal);
  5. the Collector itself not sending anything for 15 minutes (so silence never looks like health).
- **Client addresses settled:** Traefik's access log is switched on (the key chart 41.6 actually honours), and on the
  node (`kubectl logs`, never in Grafana: §5.4) it shows whether real client addresses reach the edge; if they don't,
  Traefik moves to `hostPort` and the guest-join limit sees real addresses. This closes 5a's open item.
- Dashboards and alert rules live in git (`deploy/terraform/grafana`), applied from the owner's PC like the Oracle
  Terraform.

**Non-goals**
- Paging (SMS, phone), on-call rotation, SLOs and error budgets.
- Browser or Android app telemetry (real-user monitoring).
- Continuous profiling.
- Telemetry from the stopped Compose stack.
- More than one dashboard. More panels can come later.

**Anti-goals** (failure even if it works)
- **Personal data in Grafana Cloud:** email addresses, names typed into expenses, expense descriptions, receipt text,
  tokens, passwords, SQL parameter values. A user's data must not leave the server (parent §2 anti-goal: nobody outside
  a group sees its data).
- **Telemetry breaking Kitty:** an unreachable Grafana Cloud or Collector must never fail or slow a request (exports are
  asynchronous, bounded queues, drop on overflow).
- **Cost:** anything that could bill. The free tier is used without a payment method; limits are respected (§6).
- **Cardinality blow-up:** user ids, group ids, raw URLs or amounts as metric labels.
- Plumbing nobody can explain: no operator, no auto-injection, no copy-pasted 500-line config.

## 4. Approaches (decided: 1)

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| 1 | Upstream OpenTelemetry Collector (contrib) + official SDK per service; dashboard and alerts as Terraform | Most to write; every piece standard, vendor-neutral and explainable | **Chosen** |
| 2 | Grafana Alloy (Grafana's k8s-monitoring chart) | Quicker; Grafana's own distribution, much config nobody wrote, more memory; shows "installed a chart" | Rejected |
| 3 | OpenTelemetry Operator with injected auto-instrumentation | Least code in services; an operator (parent §3 forbids) and hidden plumbing | Rejected |

## 5. Design

### 5.1 The Collector

- The upstream `otel/opentelemetry-collector-contrib` image (contrib: it has the filelog, kubeletstats, k8s_cluster,
  k8sattributes and redaction components), installed from the official `open-telemetry/opentelemetry-collector` Helm
  chart at a pinned version, as one more Argo CD Application with values in `deploy/values/production/`.
- Runs as a **DaemonSet** (one pod on the one node), because it reads the node's pod log files. Memory limit 256 MiB,
  with the `memory_limiter` processor below it.
- **Receives:** OTLP (gRPC 4317, HTTP 4318) from the services, as a cluster Service `otel-collector`.
- **Collects itself:** pod logs from `/var/log/pods` (filelog), node and pod resource use (kubeletstats), pod and
  container status and restarts (k8s_cluster), and Prometheus metrics scraped from cert-manager (certificate expiry)
  and Traefik (edge request counts and latency, if Traefik's metrics are on).
- **Enriches:** every signal gets Kubernetes attributes (namespace, pod, deployment) from `k8sattributes`.
- **Scrubs** (§5.4), then **batches** and **exports** over OTLP/HTTP to Grafana Cloud's OTLP gateway with basic auth
  (instance id + token from a SealedSecret, §5.5).
- Its own health metrics are exported too (for alert 5).

### 5.2 The services

Each service reads the standard `OTEL_*` variables (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`,
`OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`). With no endpoint set, nothing is exported, exactly as the ledger
behaves today. Production charts point them at `http://otel-collector.observability:4318` with protocol
`http/protobuf` (the Collector lives in namespace `observability`, next to its secret); Aspire points them at its
dashboard.

**Logs** (builder's call, to avoid duplicates): in production every service's logs reach Grafana once, through the
Collector's filelog receiver reading stdout; the SDKs' own log export is off there (`OTEL_LOGS_EXPORTER=none`; the .NET
defaults honour it). Locally, the SDKs export logs to the Aspire dashboard as the ledger already does.

| Service | SDK and instrumentation | Business metrics |
|---|---|---|
| ledger (.NET) | already in `Kitty.ServiceDefaults`; add Npgsql, the Kafka producer/consumer and SignalR where available; its own `ActivitySource` around the outbox | `kitty.expenses.created` (counter; label: `split_type`) |
| ai (Python, FastAPI) | `opentelemetry-sdk`, OTLP exporter, instrumentations for FastAPI, httpx, psycopg; spans around each receipt parse and each model call; Python `logging` bridged to OTLP | `kitty.receipts.read` (counter; label: `outcome` = parsed or the `ScanFailure.Reason` name), `kitty.sentences.parsed` (counter; label: `outcome`), `kitty.model.calls` (counter; labels: `kind`, `result` incl. rate-limited) |
| pulse (Go) | `go.opentelemetry.io/otel` SDK, OTLP exporter, `otelhttp`, `otelgrpc`; `slog` bridged to OTLP | `kitty.notifications.sent` (counter; labels: `channel`, `result`), `kitty.recurring.added` (counter) |
| web (Next.js) | Next's `instrumentation.ts` with the OpenTelemetry Node SDK (server side only) | none |

- **Trace across Kafka (agreed with the owner, including the schema change):** Kafka messages aren't sent by the
  request that causes them: the request writes an `OutboxMessage` row and `OutboxRelay` publishes it up to ~500 ms
  later in its own transaction. So the trace context is stored with the row: **one new nullable column on the outbox
  table** (`trace_parent`, W3C `traceparent` text), filled from the current activity for **every** outbox row, added by
  an EF migration that production applies on start (`Ledger__MigrateOnStartup`). Existing rows stay null and publish
  as before. The relay puts it in the Kafka message's `traceparent` header. The ai service extracts it, so its parse
  span is a child of the upload, and **keeps the header when it re-sends to `receipt.uploaded.retry`**, so slow
  (rate-limited) receipts stay one trace; its result message carries it back to the ledger. pulse's consumers may use
  the header later; that is not part of 5b. The protobuf contracts don't change.
- **Exports never block:** batch span/metric processors with bounded queues; on export failure, data is dropped and
  the request carries on.
- New dependencies, one set per service, pinned: the OpenTelemetry SDK and exporter for that language plus the
  instrumentation packages named above. Nothing else.

### 5.3 The backup's "last success"

The nightly `backup.sh` runs from the server's cron, outside the cluster. After a successful backup, it sends one
OTLP/HTTP metric to the Collector (gauge `kitty.backup.last_success`, Unix seconds, plus `kitty.backup.size_bytes`),
reaching the Collector's Service at its cluster IP from the node (looked up with `kubectl`; the node routes to cluster
IPs). A failure to send never fails the backup (it logs a warning).
Alert 3 fires when that gauge is more than 26 hours old, or absent.

### 5.4 Scrubbing (what may leave the server)

Applied in the Collector to every signal, so no service can leak by mistake; the SDKs are also configured not to
capture bodies:

- **Dropped attributes:** request and response bodies, all HTTP headers except `content-type` and `user-agent`, URL
  query strings (`url.query`, and the query part of any URL-valued attribute), `db.statement` values (kept only as the operation name and table, e.g. `SELECT
  expenses`), `enduser.*`, and any attribute whose key contains `token`, `password`, `secret`, `authorization`,
  `cookie`, `email`.
- **Masked anywhere in values and log bodies:** email addresses, JWTs (`eyJ…`), `Bearer …` tokens, Gemini API keys
  (`AIza…`, `AQ.…`), 16-letter app passwords.
- **Client addresses and raw paths don't leave** (builder's call, the privacy-preserving reading of the anti-goal):
  `client.address`, `ClientHost`, `X-Forwarded-For`, `network.peer.address` and every raw request path or full URL
  (`url.path`, `url.full`, `RequestPath`, `http.target`) are dropped from spans and from Traefik's access-log records,
  because raw paths carry invite tokens (`/invite/{token}`, `/api/invites/{token}/…`), which work as keys to join a
  group. Invite tokens are also masked wherever they appear in values or log bodies. The edge log in Grafana keeps
  status, duration, method, router and service only.
- **Allowed:** service, route templates (`/groups/{groupId}/expenses`, never raw paths with ids), status codes,
  durations, pod and namespace names, metric values, opaque ids inside traces (user and group UUIDs, which identify
  nobody outside Kitty).
- Log lines that carry user-entered text (the ai service's parse logs, Keycloak's event logs) are reduced to their
  level, logger and a scrubbed message; expense descriptions and receipt text never appear in logs at INFO.
- A test proves it: a known set of "dirty" spans, metrics and logs (an email in a log line, a JWT in a header, a SQL
  statement with values, a raw path) goes through the Collector's processors in CI and comes out clean.

### 5.5 Secrets and accounts

- The owner creates a Grafana Cloud free account (no payment method) and a stack, picking the region nearest South
  Africa. They create two tokens: an **OTLP write token** for the Collector and a **service account token** for
  Terraform (dashboards and alerts).
- The OTLP endpoint, instance id and write token become a SealedSecret `grafana-cloud` (namespace `observability`),
  sealed by the owner on the server (an addition to `seal-env.sh`, reading from the server's `.env`); the builder never
  sees the token. Until it exists, the Collector's pod waits for it (Argo CD retries), and the services' exports are
  simply dropped: nothing else depends on the Collector.
- The Terraform token, the stack URL and the alert email live in a git-ignored `terraform.tfvars` on the owner's PC,
  like the Oracle ones.

### 5.6 Dashboards and alerts as code

- `deploy/terraform/grafana`: the official `grafana/grafana` provider, pinned. Resources: one folder, the "Kitty"
  dashboard (its JSON in the repo, built from panels on the §3 list), an email contact point to the owner, a
  notification policy, and the five alert rules (§3) with their thresholds in code.
- State in the same private `kitty-tfstate` bucket (key `grafana/terraform.tfstate`). Run from the PC; CI runs only
  `fmt` and `validate`, as for Oracle.

### 5.7 Checks

- **CI:** chart tests extended (the Collector Application, its values, every Kitty Deployment's `OTEL_*` variables);
  the scrubbing test (§5.4); each service's own test suite covers its new metrics (a counter increments on the event)
  and that no export endpoint means no exporter. The k3d run installs the Collector with a dummy exporter (debug/
  file) and checks one trace from a smoke request reaches it with Kubernetes attributes and without scrubbed fields.
- **Locally:** with Aspire, a receipt upload shows as one trace across ledger, Kafka and ai in the Aspire dashboard.
- **On the server (Part B):** traces, metrics and logs visible in Grafana Cloud; the dashboard shows real numbers; each
  alert proven to fire once (a forced 5xx burst on a test route or a scaled-down pod, a backup timestamp set back,
  a dry-run of the certificate rule) and to email the owner; the free-tier usage page well inside limits.

## 6. Constraints

- **Grafana Cloud free tier** (as of 2026-11; checked again at sign-up): about 10k active metric series, 50 GB logs,
  50 GB traces per month, 14-day retention. Kitty's budget: under 3k series, under 2 GB logs, under 2 GB traces a month
  (a handful of users). The Collector filters noise (k3s system pods' debug logs, health-check spans).
- **Oracle Always Free** unchanged: the Collector's 256 MiB fits the ~7 GB free.
- No personal data leaves the server (§5.4). No payment method on Grafana Cloud.
- The Gemini key and SMTP password are never handled by the builder (5a rule); the same for Grafana tokens.
- No custom operators; Helm charts and Argo CD as in 5a.
- New dependencies only as listed in §5.2, plus the Collector chart and the Grafana Terraform provider.

## 7. Left to the builder

- Exact SDK and instrumentation package versions (latest stable, pinned) and how each service initialises them.
- The Collector's exact pipeline config, within §5.1 and §5.4, and whether Traefik's own metrics/traces are switched
  on (nice to have) or only its access log.
- Panel layout and queries of the dashboard.
- How the k3d check inspects the exported trace (debug exporter output, a file exporter, or a tiny OTLP sink).
- Whether log export is through the SDKs or only the filelog receiver for each service, as long as every service's
  logs arrive once and scrubbed.
