# Kitty Phase 5a: k3s, Helm, Argo CD and Terraform — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kitty runs on k3s on the existing Oracle server, deployed by Argo CD from `deploy/`, with Oracle resources in Terraform, and the 16 smoke checks pass after the switch.

**Architecture:** Part A (Tasks 1–12) builds everything in the repo and proves it in CI, including a full install into a throwaway k3d cluster that runs `smoke.sh`. Part B (Tasks 13–16) is the server work: install, rehearsal, Terraform import, the switch. Every Part B step that changes the server, Oracle or data is confirmed with the owner first.

**Tech Stack:** k3s (bundled Traefik v3, CoreDNS, local-path, ServiceLB), Helm 3, Argo CD, cert-manager, Sealed Secrets, Terraform + OCI provider, kubeconform, k3d (CI only), pytest (run ephemerally via `uv run --with`).

**Spec:** `docs/superpowers/specs/2026-11-27-kitty-phase5a-k3s-design.md`

## Global Constraints

- Oracle Always Free only (A1 2 OCPU / 12 GB, 200 GB block, 20 GB Object Storage); PAYG account with a US$1 budget alert that must stay quiet.
- No secret, and no personal detail (Gmail address, OCIDs, alert email), in git or Terraform state. The repo is public.
- The builder never reads, prints or handles the Gemini key or the Gmail app password; the owner runs any command that touches them.
- Confirm with the owner before any command that changes the server, Oracle resources, GitHub settings or data.
- No custom operators for Kitty's data (cert-manager, Sealed Secrets, Argo CD are accepted). No changes to Kitty's service code.
- `deploy/compose/smoke.sh kitty-split.duckdns.org` must pass all 16 checks against the cluster, unchanged in what it checks.
- Memory limits carried over from Compose: postgres 1Gi, keycloak 1Gi, redpanda 1500Mi, ai 1500Mi, ledger 512Mi, web 512Mi, azurite 256Mi, pulse 128Mi, redis 64Mi.
- Pinned versions everywhere (images, charts, actions by SHA as the repo already does, Terraform providers).
- Conventional commits; no Claude attribution in commits or PRs.
- Tools installed on the owner's PC (winget, ask first): `helm`, `kubeconform`, `kubeseal`, `terraform`. `k3d` runs only in CI. Python tests run with `uv run --with pytest --with pyyaml pytest deploy/tests` (nothing added to any project's dependencies).

## Review Focus

1. **Everything restarts at once** (a reboot, or all pods deleted): Kitty comes back with no manual step, because each pod waits for its dependencies. Pinned by Task 10's "delete every pod, smoke again" step.
2. **A chart or Application removed from git:** Argo CD prunes it, but the Postgres, Redpanda and Azurite volumes survive. Pinned by Task 8's `test_stateful_volumes_are_kept`.
3. **A receipt photo over 11 MB** is refused with 413 at the edge, and one just under goes through to Azurite's own signature check. Pinned by Task 10's upload-size step.
4. **SignalR's WebSocket upgrade** through Traefik reaches the ledger (not a 404 or 400 from the edge). Pinned by Task 10's upgrade step.
5. **Real client addresses** reach the web app (the guest-join limit keys on them), not the node's address. Pinned by Task 15's access-log step.

---

## Part A — in the repo

### Task 1: Test harness and the repo layout

**Files:**
- Create: `deploy/tests/conftest.py`, `deploy/tests/test_layout.py`, `deploy/charts/.gitkeep` (removed once a chart exists)
- Create: `.github/workflows/deploy.yml`

**Interfaces:**
- Produces: pytest fixtures `render(chart: str) -> list[dict]` (runs `helm template <chart> deploy/charts/<chart> -f deploy/values/production/<chart>.yaml --namespace kitty`, returns the parsed documents), `compose() -> dict` (parsed `deploy/compose/docker-compose.yml`), `kinds(docs, kind) -> list[dict]`. Constants `KITTY_CHARTS = ["kitty-ledger", "kitty-web", "kitty-ai", "kitty-pulse"]`, `SUPPORT_CHARTS = ["postgres", "keycloak", "redis", "redpanda", "azurite"]`, `EDGE_CHART = "kitty-edge"`.
- Produces: workflow `deploy` with job `charts` (pytest + `helm lint` + kubeconform) on PRs and pushes touching `deploy/**` or `infra/keycloak/**`.

- [ ] **Step 1:** Ask the owner to approve installing `helm`, `kubeconform`, `kubeseal`, `terraform` with winget; install; record versions in the ledger.
- [ ] **Step 2: Write the failing test** `test_layout.py::test_every_chart_has_production_values`: for every chart name in the three lists, `deploy/charts/<name>/Chart.yaml` and `deploy/values/production/<name>.yaml` exist.
- [ ] **Step 3:** Run `uv run --with pytest --with pyyaml pytest deploy/tests -q`. Expected: FAIL (no charts).
- [ ] **Step 4:** Write `conftest.py` and `deploy.yml`. The workflow installs Helm and kubeconform (pinned), runs the pytest command, `helm lint` per chart, and `helm template … | kubeconform -strict -summary -schema-location default -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'` (Traefik, cert-manager, Argo CD, Sealed Secrets CRDs; a kind missing from that catalog, such as k3s's `HelmChartConfig`, is named in an explicit `-skip` list). The test stays red until Task 2; commit with the test marked `xfail(strict=True)` and remove the mark in Task 7 when the last chart lands.
- [ ] **Step 5: Commit** `test(deploy): chart test harness and deploy workflow`.

### Task 2: Supporting charts — postgres, redis, redpanda, azurite

**Files:**
- Create: `deploy/charts/{postgres,redis,redpanda,azurite}/` (`Chart.yaml`, `templates/*.yaml`, `values.yaml`), `deploy/charts/postgres/files/10-keycloak.sql` (copy of `deploy/compose/postgres-init.sql`)
- Create: `deploy/values/production/{postgres,redis,redpanda,azurite}.yaml`
- Test: `deploy/tests/test_support_charts.py`

**Interfaces:**
- Produces Services (namespace `kitty`): `postgres:5432`, `redis:6379`, `redpanda:9092` (+ `8081` schema registry, `33145` rpc), `azurite:10000`. Same names as Compose, so every connection string carries over.
- Consumes: Secret `kitty-secrets` keys `POSTGRES_PASSWORD`, `BLOB_ACCOUNT_KEY` (Task 6).
- Produces label `app.kubernetes.io/name: <chart>` on every pod (backup/restore scripts select by it).

- [ ] **Step 1: Write the failing tests:**
  - `test_images_match_compose`: each chart's container image equals the Compose service's `image` (`pgvector/pgvector:pg17`, `redis:7.4-alpine`, `docker.redpanda.com/redpandadata/redpanda:v26.2.6`, `mcr.microsoft.com/azure-storage/azurite:3.37.0`).
  - `test_memory_limits_match_compose`: limits are exactly the Global Constraints values.
  - `test_stateful_pieces_have_kept_volumes`: postgres, redpanda, azurite are StatefulSets with a `volumeClaimTemplate` on storage class `local-path`, and the claim template carries `helm.sh/resource-policy: keep`. Sizes: postgres 10Gi, redpanda 5Gi, azurite 5Gi.
  - `test_commands_match_compose`: redis and redpanda args equal Compose's `command` list except `--advertise-kafka-addr=PLAINTEXT://redpanda:9092` and `--advertise-rpc-addr=redpanda:33145`, which keep the same Service names; azurite's args equal Compose's.
  - `test_probes`: postgres readiness runs `pg_isready -U postgres -d ledger`; redis `redis-cli ping`; redpanda `rpk cluster health` grep as in Compose.
  - `test_postgres_init_sql_is_the_compose_copy`: `files/10-keycloak.sql` is byte-identical to `deploy/compose/postgres-init.sql`.
- [ ] **Step 2:** Run the pytest command. Expected: FAIL (charts missing).
- [ ] **Step 3:** Write the four charts. Postgres: `POSTGRES_DB=ledger`, password from `kitty-secrets`, init SQL mounted at `/docker-entrypoint-initdb.d/10-keycloak.sql` from a ConfigMap built with `.Files.Get`, `PGDATA` in a subdirectory of the volume. Azurite: `AZURITE_ACCOUNTS` = `kitty:$(BLOB_ACCOUNT_KEY)` with `BLOB_ACCOUNT_KEY` from the Secret defined first. Redis: no volume.
- [ ] **Step 4:** Run the pytest command and `helm lint` on each. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): helm charts for postgres, redis, redpanda and azurite`.

### Task 3: Keycloak chart

**Files:**
- Create: `deploy/charts/keycloak/` with `files/kitty-realm.json` (copy of `infra/keycloak/kitty-realm.json`), `deploy/values/production/keycloak.yaml`
- Test: `deploy/tests/test_keycloak_chart.py`

**Interfaces:**
- Produces Service `keycloak:8080` (HTTP, `/auth` relative path) and management port 9000 for probes.
- Consumes `kitty-secrets` keys `POSTGRES_PASSWORD`, `KEYCLOAK_ADMIN_PASSWORD`, `KITTY_WEB_CLIENT_SECRET`, `PULSE_CLIENT_SECRET`, `KITTY_MCP_CLIENT_SECRET`, `SMTP_FROM`, `SMTP_USER`, `SMTP_PASSWORD`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Values: `host` (`kitty-split.duckdns.org`), `smtp.host`, `smtp.port`, `smtp.ssl`, `smtp.starttls`, `googleEnabled`, `verifyEmail`.

- [ ] **Step 1: Write the failing tests:**
  - `test_env_names_match_compose`: the set of env var names on the Keycloak container equals the Compose `keycloak.environment` keys.
  - `test_env_values`: `KC_HOSTNAME=https://kitty-split.duckdns.org/auth`, `KC_HOSTNAME_ADMIN=http://localhost:8180/auth`, `KC_HTTP_RELATIVE_PATH=/auth`, `KC_PROXY_HEADERS=xforwarded`, `KC_DB_URL=jdbc:postgresql://postgres:5432/keycloak`, `KITTY_PUBLIC_URL=https://kitty-split.duckdns.org`.
  - `test_imports_realm_on_start`: args are `["start", "--import-realm"]`; the realm ConfigMap is mounted at `/opt/keycloak/data/import/kitty-realm.json`.
  - `test_realm_is_the_infra_copy`: `files/kitty-realm.json` is byte-identical to `infra/keycloak/kitty-realm.json`.
  - `test_waits_for_postgres`: an init container runs `pg_isready -h postgres -U postgres` in a loop.
  - `test_not_exposed`: the Service is `ClusterIP`; no `hostPort` anywhere.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Write the chart; secret-valued env vars use `secretKeyRef`, every other value comes from values. Readiness/liveness on the management port's health endpoint (check the exact path for Keycloak 26.6 with `/auth` relative path in its docs; record in the ledger).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): keycloak chart with the kitty realm import`.

### Task 4: Kitty service charts — ledger, web, ai, pulse

**Files:**
- Create: `deploy/charts/kitty-{ledger,web,ai,pulse}/`, `deploy/charts/kitty-ai/files/ai-db-setup.sql`, `deploy/charts/kitty-pulse/files/pulse-db-setup.sql` (copies), `deploy/values/production/kitty-*.yaml`
- Test: `deploy/tests/test_kitty_charts.py`

**Interfaces:**
- Produces Services `ledger:8080` and `ledger:8082` (gRPC for pulse), `web:3000`, `ai:8000`, `pulse:5090`.
- Values each chart reads: `image.repository` (`ghcr.io/flyinginsectsunpig/kitty-<name>`), `image.tag` (`sha-<7>`; Task 9 writes it), `host`.
- pulse values: `notifications.enabled` (bool). `false` sets `PULSE_SMTP_HOST` and `PULSE_FCM_CREDENTIALS` to empty strings (pulse then logs "email notifications are off"); production starts `false` until the switch (Task 15).
- Consumes `kitty-secrets` keys: ledger `POSTGRES_PASSWORD`, `BLOB_ACCOUNT_KEY`; web `AUTH_SECRET`, `KITTY_WEB_CLIENT_SECRET`; ai `AI_DB_PASSWORD`, `BLOB_ACCOUNT_KEY`, `GEMINI_API_KEY`, `KITTY_MCP_CLIENT_SECRET`, `POSTGRES_PASSWORD` (setup only); pulse `PULSE_DB_PASSWORD`, `PULSE_CLIENT_SECRET`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `POSTGRES_PASSWORD` (setup only). Optional Secret `pulse-fcm` (key `fcm.json`) mounted at `/secrets/fcm.json` when `fcm.enabled`.

- [ ] **Step 1: Write the failing tests:**
  - `test_env_names_match_compose` (parametrized over the four): container env names equal the Compose service's environment keys.
  - `test_connection_values`: ledger `ConnectionStrings__ledger` is `Host=postgres;Database=ledger;Username=postgres;Password=$(POSTGRES_PASSWORD)` with `POSTGRES_PASSWORD` defined earlier in the env list; `Auth__Authority=https://kitty-split.duckdns.org/auth/realms/kitty`; `ASPNETCORE_HTTP_PORTS=8080;8082`; ai `AI_MCP_PUBLIC_URL=https://kitty-split.duckdns.org/ai/mcp`; web `LEDGER_URL=http://ledger:8080`, `AI_URL=http://ai:8000`; pulse `PULSE_LEDGER_GRPC=ledger:8082`.
  - `test_db_setup_runs_before_start`: ai and pulse each have an init container `db-setup` (image `pgvector/pgvector:pg17`) running `psql -v <role>_password=$(…) -f /setup/<file>.sql` against `postgres`/`ledger`, and its SQL file is byte-identical to `deploy/compose/<file>.sql`.
  - `test_waits_for_dependencies`: ledger's init containers wait for postgres, redis, redpanda and pulse; ai waits for redpanda and azurite; pulse waits for redpanda and keycloak (TCP checks; image `busybox` pinned).
  - `test_notifications_off_by_default`: pulse rendered with production values has `PULSE_SMTP_HOST=""` and `PULSE_FCM_CREDENTIALS=""`; with `--set notifications.enabled=true` it has `PULSE_SMTP_HOST` from values (`smtp.gmail.com`).
  - `test_images_are_pinned_tags`: every Kitty image tag matches `^sha-[0-9a-f]{7}$`; never `latest`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Write the four charts. Ruling recorded against spec §5.2: the db-setup one-shots become **init containers**, not Argo CD sync-hook Jobs, because Argo CD doesn't order hooks across Applications (postgres is another Application) and an init container runs "on every start", exactly as Compose does today. Probes: ledger `/health`, ai `/health` (start period 60s), pulse `/pulse -health`, web HTTP `/` on 3000.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): helm charts for ledger, web, ai and pulse`.

### Task 5: Edge chart — Traefik routes, certificates, in-cluster DNS

**Files:**
- Create: `deploy/charts/kitty-edge/` (`templates/`: `ingressroutes.yaml`, `middlewares.yaml`, `deny.yaml`, `issuers.yaml`, `certificate.yaml`, `coredns-custom.yaml`, `traefik-config.yaml`), `deploy/values/production/kitty-edge.yaml`
- Test: `deploy/tests/test_edge_chart.py`

**Interfaces:**
- Values: `host`, `acme.server` (`production` | `staging`), `tls.selfSigned` (bool, CI only), `traefik.nodePorts` (`web: 30080`, `websecure: 30443`). The ACME account has **no email**: the ClusterIssuer is public in git, and Let's Encrypt accepts registration without one.
- Produces: Deployment+Service `edge-deny` (image `caddy:2.11.9-alpine`, Caddyfile `:8080 { respond 404 }`, 16Mi limit), the only way to answer a fixed 404 in Traefik.
- Produces (kube-system): ConfigMap `coredns-custom` with `kitty.override` = `rewrite name <host> traefik.kube-system.svc.cluster.local`; `HelmChartConfig traefik` setting nodePorts, `externalTrafficPolicy: Local`, access logs on, HTTP→HTTPS redirect on the `web` entrypoint except `/.well-known/acme-challenge/`.

- [ ] **Step 1: Write the failing tests** (one per spec §5.4 row; assertions on the rendered `IngressRoute` `match` strings, services and middlewares):
  - `test_keycloak_allowlist`: route to `keycloak:8080` matches exactly ``(Path(`/auth/realms/kitty`) || PathPrefix(`/auth/realms/kitty/`) || PathPrefix(`/auth/resources/`)) && !PathRegexp(`;`)``; a lower-priority `PathPrefix(`/auth`)` route goes to `edge-deny`.
  - `test_web_auth_routes_before_ledger`: ``PathPrefix(`/api/auth/`)`` → `web:3000` has higher priority than ``PathPrefix(`/api`)`` → `ledger:8080` with a strip-prefix `/api` middleware.
  - `test_blob_is_put_only`: ``PathPrefix(`/blob/`) && Method(`PUT`)`` → `azurite:10000` with strip-prefix `/blob` and a buffering middleware `maxRequestBodyBytes: 11534336`; ``PathPrefix(`/blob`)`` otherwise → `edge-deny`.
  - `test_mcp_metadata_and_ai`: ``PathPrefix(`/.well-known/oauth-protected-resource`)`` → `ai:8000` without stripping; ``PathPrefix(`/ai/`)`` → `ai:8000` with strip-prefix `/ai`.
  - `test_default_goes_to_web`: lowest-priority ``PathPrefix(`/`)`` → `web:3000`.
  - `test_headers_on_every_route`: every route on `websecure` uses middlewares `security-headers` (HSTS `max-age=31536000`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Server` removed) and `compress`.
  - `test_tls`: production values render a `ClusterIssuer` for `https://acme-v02.api.letsencrypt.org/directory` with an HTTP-01 Traefik solver, and a `Certificate` for the host; `tls.selfSigned=true` renders a `selfSigned` issuer instead.
  - `test_coredns_rewrite` and `test_traefik_config` (nodePorts 30080/30443, `externalTrafficPolicy: Local`).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Write the chart. Priorities are explicit numbers on each route (no reliance on rule length).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): traefik routes matching the caddyfile, certificates and in-cluster dns`.

### Task 6: Secrets — sealing from the server's `.env`

**Files:**
- Create: `deploy/k3s/seal-env.sh`, `deploy/secrets/production/.gitkeep`
- Test: `deploy/tests/test_seal_env.py`

**Interfaces:**
- `seal-env.sh <env-file> [--plain]`: reads only these keys, in this order, and refuses (exit 2, naming the key, never its value) if any is missing or empty except the optional three: `POSTGRES_PASSWORD KEYCLOAK_ADMIN_PASSWORD AUTH_SECRET KITTY_WEB_CLIENT_SECRET BLOB_ACCOUNT_KEY AI_DB_PASSWORD PULSE_DB_PASSWORD PULSE_CLIENT_SECRET KITTY_MCP_CLIENT_SECRET GEMINI_API_KEY SMTP_USER SMTP_FROM SMTP_PASSWORD` and optional `GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET` (default `unset`). Builds Secret `kitty-secrets` (namespace `kitty`) with `kubectl create secret generic --dry-run=client -o yaml` and pipes it to `kubeseal --format yaml`; writes the SealedSecret to stdout. `--plain` skips kubeseal (CI's k3d install and the tests use it).
- Run by the **owner** on the server (it reads `.env`, which holds the Gemini key and Gmail app password); the builder only commits its encrypted output.

- [ ] **Step 1: Write the failing tests** (with a fake env file of dummy values and `--plain`):
  - `test_secret_has_exactly_the_listed_keys`: output Secret's `data` keys equal the 15 names; `KITTY_HOST`, `SMTP_HOST`, `KITTY_TAG` are absent.
  - `test_missing_key_is_refused_by_name`: dropping `AUTH_SECRET` → exit 2, stderr contains `AUTH_SECRET`, and no dummy value appears in stdout or stderr.
  - `test_every_secret_reference_is_provided`: every `secretKeyRef` key with name `kitty-secrets` across all rendered charts is one of the 15 (and every one of the 15 is referenced somewhere).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Write the script (`set -euo pipefail`, values never echoed).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): seal the server's settings into a sealed secret`.

### Task 7: Argo CD — root app, one Application per chart, bootstrap

**Files:**
- Create: `deploy/apps/root.yaml`, `deploy/apps/<chart>.yaml` (×10 Kitty charts), `deploy/apps/{cert-manager,sealed-secrets,kitty-secrets}.yaml`, `deploy/platform/argocd-values.yaml`, `deploy/k3s/bootstrap.sh`
- Test: `deploy/tests/test_apps.py`

**Interfaces:**
- `bootstrap.sh <git-revision>`: installs Argo CD from the official chart (pinned) with `argocd-values.yaml` (one replica each, Dex and notifications off, not exposed), then applies `root.yaml` with `targetRevision` set to `<git-revision>` for the root and every child (Task 13 uses the branch, Task 15 `main`). Idempotent.
- Root Application `kitty-root` → path `deploy/apps`. Children: `cert-manager` and `sealed-secrets` from their upstream Helm repos at pinned versions (Sealed Secrets controller in `kube-system`, named `sealed-secrets-controller` so `kubeseal` finds it by default); `kitty-secrets` → path `deploy/secrets/production`; one per chart with `helm.valueFiles: [../../values/production/<chart>.yaml]`.
- Sync policy for every child: automated, `prune: true`, `selfHeal: true`, `retry` with backoff (CRDs and the Secret may arrive after the charts that use them).

- [ ] **Step 1: Write the failing tests:**
  - `test_every_chart_has_an_application`: each of the 10 chart dirs has exactly one Application whose path and value file exist.
  - `test_stateful_volumes_are_kept` (Review Focus 2): postgres, redpanda, azurite Applications don't set `PrunePropagationPolicy=foreground` or anything that deletes PVCs, and their charts' claim templates keep `helm.sh/resource-policy: keep` (re-asserted here against the Application's rendered output).
  - `test_versions_are_pinned`: every upstream `targetRevision` is an exact version (no `*`, `^`, `~`, `HEAD`).
  - `test_revision_is_a_parameter`: no file in `deploy/apps` hardcodes a branch; `bootstrap.sh` sets it.
- [ ] **Step 2:** Run. Expected: FAIL. Then remove Task 1's `xfail` mark.
- [ ] **Step 3:** Write the files.
- [ ] **Step 4:** Run the whole suite. Expected: PASS, including `test_every_chart_has_production_values`.
- [ ] **Step 5: Commit** `feat(deploy): argo cd app of apps and bootstrap`.

### Task 8: Scripts — smoke through another port, backups and restore on k3s, data comparison

**Files:**
- Modify: `deploy/compose/smoke.sh`, `deploy/compose/backup.sh`
- Create: `deploy/k3s/restore.sh`, `deploy/k3s/compare-data.sh`
- Test: `deploy/tests/test_scripts.py` (stubs `curl`, `docker`, `kubectl` on `PATH` that log their arguments)

**Interfaces:**
- `smoke.sh <host> [--insecure | --connect-to <addr>:<port>]`: `--connect-to` adds `--connect-to <host>:443:<addr>:<port>` to every curl, keeping URLs and the issuer check unchanged. `--insecure` behaves as today.
- `backup.sh`: new `KITTY_BACKUP_TARGET=compose|k3s` (default `compose`, so tonight's cron keeps working). `k3s` runs the same dumps with `kubectl -n kitty exec <pod>` where the pod is found by `-l app.kubernetes.io/name=postgres` / `azurite`. Archive contents and upload unchanged.
- `restore.sh <archive>`: refuses without a readable archive; scales `kitty-ledger`, `kitty-web`, `kitty-ai`, `kitty-pulse`, `keycloak` Deployments to 0; restores `globals.sql`, then for `ledger` and `keycloak`: `dropdb --if-exists`, `createdb`, `pg_restore --exit-on-error`; untars `azurite.tar.gz` into the Azurite pod's `/data`; scales back to 1; waits for rollouts.
- `compare-data.sh`: for databases `ledger` and `keycloak`, prints per table `<schema.table> <row count> <md5 of the table's rows ordered by their text form>`, from Compose's Postgres (`docker exec`) and the cluster's (`kubectl exec`), and diffs them; exit 0 only if identical.

- [ ] **Step 1: Write the failing tests:**
  - `test_smoke_connect_to_passes_through`: with stub curl, `smoke.sh h --connect-to 127.0.0.1:30443` → every curl call has `--connect-to h:443:127.0.0.1:30443` and URLs start `https://h/`.
  - `test_backup_k3s_uses_kubectl`: `KITTY_BACKUP_TARGET=k3s` → stub log has `kubectl -n kitty exec` for `pg_dumpall`, `pg_dump … ledger`, `pg_dump … keycloak`, azurite `tar`; no `docker` calls.
  - `test_backup_default_is_compose`: unset → only `docker exec` calls, as today.
  - `test_restore_order`: stub log order is scale-to-0 (all five) → globals → ledger → keycloak → azurite → scale-to-1.
  - `test_restore_refuses_without_archive`: exit 2, no kubectl calls.
  - `test_compare_reports_difference`: stubs return one different md5 → non-zero exit and the table name printed.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS. Also `bash -n` on each script.
- [ ] **Step 5: Commit** `feat(deploy): backups, restore and smoke checks for the k3s cluster`.

### Task 9: CI writes the new image tag into `deploy/`

**Files:**
- Create: `deploy/k3s/set-image-tag.sh`
- Modify: `.github/workflows/images.yml`
- Test: `deploy/tests/test_set_image_tag.py`

**Interfaces:**
- `set-image-tag.sh <tag>`: tag must match `^sha-[0-9a-f]{7}$` (exit 2 otherwise); rewrites `image.tag` in `deploy/values/production/kitty-{ledger,web,ai,pulse}.yaml` only.
- `images.yml` new job `deploy-tag` (`needs: build`, `permissions: contents: write`, `concurrency: deploy-tag`): checks out `main`, runs `set-image-tag.sh sha-${GITHUB_SHA::7}`, commits `chore(deploy): images sha-<7> [skip ci]` as `github-actions[bot]`, pushes with one `git pull --rebase` retry. Pushes made with `GITHUB_TOKEN` don't start workflows, and `[skip ci]` makes it explicit: no loop.

- [ ] **Step 1: Write the failing tests:** `test_updates_the_four_values_files` (on a temp copy of `deploy/`: the four files have the new tag, no other file changed, git diff touches only `tag:` lines); `test_rejects_bad_tags` (`latest`, `sha-XYZ`, empty → exit 2, nothing changed).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the script and the job.
- [ ] **Step 4:** Run. Expected: PASS. `actionlint` isn't installed; check the workflow YAML parses (`python -c "import yaml…"`) and review the job by eye.
- [ ] **Step 5: Commit** `ci(deploy): write each published image tag into deploy/ for argo cd`.

### Task 10: CI installs everything into k3d and runs the smoke checks

**Files:**
- Modify: `.github/workflows/deploy.yml` (job `k3d`)
- Create: `deploy/tests/ci-values/` (overrides: `tls.selfSigned: true`, `host: kitty.localhost`, notifications off)

**Interfaces:**
- Consumes: every chart, `seal-env.sh --plain` (with generated dummy values; `GEMINI_API_KEY` empty is refused, so CI passes a dummy that fails at the model, which only the receipt reader would notice), `smoke.sh --insecure`.

- [ ] **Step 1:** Write the job: create a k3d cluster (pinned k3s image) with ports 80/443 mapped; apply `traefik-config`; install cert-manager from its pinned chart; `helm install` every chart in dependency order with production values plus `ci-values`; wait for all Deployments/StatefulSets Ready (10 min timeout).
- [ ] **Step 2:** Run `deploy/compose/smoke.sh kitty.localhost --insecure`. Expected on first push: whatever fails, read it. Fix charts (not the smoke checks) until all 16 pass; each fix is its own commit naming the check it fixes.
- [ ] **Step 3 (Review Focus 3):** in the job: PUT 12 MiB to `/blob/kitty/receipts/big` → `413`; PUT 1 KiB → Azurite's `<Code>` error (reaches storage).
- [ ] **Step 4 (Review Focus 4):** `curl -i -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: …' https://kitty.localhost/api/hubs/table` → status is not `404` and not a Traefik error page (`101`, `400` from SignalR's own body, or `401` are fine; assert the response came from the ledger by its body/headers).
- [ ] **Step 5 (Review Focus 1):** `kubectl -n kitty delete pods --all`, wait Ready again, run `smoke.sh` again. Expected: 16/16.
- [ ] **Step 6: Commit** `ci(deploy): install the charts into k3d and run the smoke checks`.

### Task 11: Terraform for the Oracle resources (code only)

**Files:**
- Create: `deploy/terraform/oracle/{versions.tf,backend.tf,variables.tf,network.tf,instance.tf,budget.tf,storage.tf,iam.tf,imports.tf,terraform.tfvars.example,.gitignore}`
- Test: `deploy/tests/test_terraform.py`; CI step in `deploy.yml`: `terraform fmt -check -recursive` and `terraform init -backend=false && terraform validate`.

**Interfaces:**
- Variables (no defaults for personal values): `tenancy_ocid`, `compartment_ocid`, `region` (default `af-johannesburg-1`), `budget_alert_email`, `object_storage_namespace`.
- Resources (names fixed): `oci_core_instance.kitty`, `oci_core_vcn.main`, `oci_core_subnet.public`, `oci_core_internet_gateway.main`, `oci_core_default_route_table.main` (or `oci_core_route_table` — whichever the real VCN uses), `oci_core_security_list.public` (ingress TCP 22, 80, 443 from `0.0.0.0/0`; nothing else), `oci_budget_budget.cost_guard`, `oci_budget_alert_rule.cost_guard`, `oci_objectstorage_bucket.backups`, `oci_objectstorage_object_lifecycle_policy.backups`, `oci_identity_policy.backups_lifecycle`. `imports.tf` holds `import {}` blocks with IDs passed by variable or looked up at Task 14.
- Backend: Terraform's `oci` backend (Terraform ≥ 1.12) on bucket `kitty-tfstate`, key `oracle/terraform.tfstate`, using `~/.oci/config`. The bucket is created once by hand (Task 14), not by Terraform.

- [ ] **Step 1: Write the failing tests:** `test_instance_cannot_be_destroyed` (`prevent_destroy = true` in `oci_core_instance.kitty`'s lifecycle, and `ignore_changes` includes `source_details`, `metadata`, `create_vnic_details`); `test_no_personal_values_committed` (`.gitignore` lists `terraform.tfvars`, `*.tfstate*`, `.terraform/`; no `.tf` file contains `ocid1.tenancy`, `@`, or `84.12.81.68`); `test_no_upload_link_in_terraform` (no `oci_objectstorage_preauthrequest`).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Write the Terraform (shapes and attributes matching what exists; real values arrive at import, Task 14).
- [ ] **Step 4:** Run tests, `terraform fmt -check`, `terraform validate`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(deploy): terraform for the oracle server, network, budget and backups bucket`.

### Task 12: Runbook

**Files:**
- Create: `deploy/k3s/RUNBOOK.md`
- Modify: `deploy/compose/RUNBOOK.md` (top note: production is now k3s; Compose is for running without .NET; the "reserve the public IP" step is corrected: the IP is ephemeral, see k3s runbook)

**Interfaces:** none (prose). Sections: architecture sketch; reaching the cluster (`ssh -L 6443:127.0.0.1:6443`, kubeconfig); first install from nothing (k3s config, `bootstrap.sh`, restoring the Sealed Secrets key, `seal-env.sh`); how a merge reaches the server; rolling back (revert the tag commit); Keycloak admin (`kubectl port-forward svc/keycloak 8180:8080`); backups and `restore.sh`; Terraform (tfvars, init, plan, never apply a replace); if the IP changes (update DuckDNS); the Sealed Secrets key (where it's kept, how to restore it).

- [ ] **Step 1:** Write it, every command copied from the scripts/tasks above (no command that the tasks didn't define).
- [ ] **Step 2:** Check each command against its script's usage line.
- [ ] **Step 3: Commit** `docs(deploy): k3s runbook`.

**Then:** the whole-branch review (executing-plans' final review), its fix pass, push, open the PR (don't merge: Part B runs against the branch first). Ask the owner to review the PR.

---

## Part B — on the server (confirm each step with the owner before running it)

### Task 13: Install k3s and the platform, sealed secrets in

**Interfaces:**
- Consumes: `bootstrap.sh`, `seal-env.sh`, Task 7's Applications.
- Produces: a running cluster syncing `feat/phase5a-k3s`, notifications off, Postgres empty; a commit with `deploy/secrets/production/kitty-secrets.yaml`.

- [ ] **Step 1:** Install k3s v1.37.2+k3s1 with `deploy/k3s/config-alongside-compose.yaml` as `/etc/rancher/k3s/config.yaml` (ServiceLB **off**: its hostPorts are iptables rules that would take 80/443 from Caddy); copy the kubeconfig to `~ubuntu/.kube/config`. The API (6443) stays closed in Oracle's security list and iptables. Expected: node Ready, and `curl -sI https://kitty-split.duckdns.org` still answered by Caddy.
- [ ] **Step 2:** `bootstrap.sh feat/phase5a-k3s`. Expected: Argo CD Applications appear; cert-manager and Sealed Secrets Healthy; Kitty charts waiting for `kitty-secrets`.
- [ ] **Step 3:** The owner exports the Sealed Secrets key to their PC (command in the runbook; the builder doesn't handle its contents) and confirms where it's kept.
- [ ] **Step 4:** The owner runs `seal-env.sh ~/kitty/deploy/compose/.env > kitty-secrets.yaml` on the server; the builder copies the encrypted file into `deploy/secrets/production/`, commits `chore(deploy): sealed production settings`, pushes. Expected: Argo CD syncs; every pod Ready within 10 minutes; `edge-deny`'s and Traefik's routes present.
- [ ] **Step 5:** Memory check: `free -m` and `kubectl top pods -A` (metrics-server is bundled). Expected: under 8 GB used with Compose and k3s both running. Record numbers.

### Task 14: Rehearsal — real certificate, restore, compare; Terraform import

- [ ] **Step 1 (confirm):** add to the live Caddyfile a `handle /.well-known/acme-challenge/*` block forwarding to `<server private IP>:30080`, reload Caddy, run `smoke.sh kitty-split.duckdns.org` (16/16, Compose unaffected). Expected: cert-manager's `Certificate` Ready with a Let's Encrypt production certificate.
- [ ] **Step 2:** `restore.sh` with last night's archive from `~/kitty-backups`. Expected: rollouts complete; Azurite restarted with the photos.
- [ ] **Step 3:** On the server: `smoke.sh kitty-split.duckdns.org --connect-to <server private IP>:30443`. Expected: 16/16 against the cluster.
- [ ] **Step 4:** `compare-data.sh`. Expected: identical for every table not written since last night's backup; any difference is explained by rows written today (check their timestamps) — else stop and investigate.
- [ ] **Step 5 (confirm):** create bucket `kitty-tfstate` (private), write `terraform.tfvars` on the PC, `terraform init`, `terraform plan` with the import blocks. Expected: only imports, **0 to add, 0 to change, 0 to destroy**. Adjust the `.tf` code (never the real resources) until it is. Then `terraform apply` (imports only), commit the code changes.

### Task 15: Merge and the switch

- [ ] **Step 1:** Owner reviews and merges the PR. `bootstrap.sh main`. Expected: every Application Synced to `main`.
- [ ] **Step 2 (confirm; downtime starts):** stop Compose's `web ledger ai pulse keycloak`; `backup.sh` (compose target); `restore.sh <that archive> --no-start`; `compare-data.sh` → identical.
- [ ] **Step 3:** stop Compose entirely (`docker compose stop`); copy `deploy/k3s/config.yaml` over `/etc/rancher/k3s/config.yaml` and `sudo systemctl restart k3s` (ServiceLB on); start the apps (the command `restore.sh --no-start` printed). Expected: ServiceLB serves 80/443.
- [ ] **Step 4:** set pulse `notifications.enabled: true` in `deploy/values/production/kitty-pulse.yaml`, commit, push to `main`; Argo CD syncs.
- [ ] **Step 5:** `smoke.sh kitty-split.duckdns.org` from the PC. Expected: 16/16. Downtime ends. If anything fails and can't be fixed in minutes: way back (runbook): `sudo systemctl stop k3s && sudo /usr/local/bin/k3s-killall.sh`, then `docker compose up -d`.
- [ ] **Step 6 (Review Focus 5):** from the owner's PC, open the site; Traefik's access log line for that request shows the PC's public address, not the node's or `10.42.x`. Also send one request with a forged `X-Forwarded-For: 1.2.3.4` and check the address Traefik passes on still starts with the real one. If ServiceLB hides addresses, move Traefik to `hostPort` (HelmChartConfig) and re-check; the runbook records which.
- [ ] **Step 7:** The owner signs in in a browser, opens a group, adds a test expense and deletes it; a typed sentence; a receipt photo; a foreign-currency expense; MCP discovery from Claude/ChatGPT if they use it.
- [ ] **Step 8 (confirm):** change `/etc/cron.d/kitty-backup` to `KITTY_BACKUP_TARGET=k3s`; run it once by hand; check the archive and the upload.

### Task 16: Close out

- [ ] **Step 1:** Update the memory note on the Oracle server (k3s now, Compose kept stopped until a date a week out, where the Sealed Secrets key is, Terraform state bucket).
- [ ] **Step 2:** Offer the owner a follow-up a week later: remove Compose (`docker compose down`, volumes after a final backup, Docker itself).
