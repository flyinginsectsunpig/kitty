# Kitty Phase 5a: k3s, Helm, Argo CD and Terraform (design)

Status: design, 2026-11-27. Parent design: `2026-11-15-kitty-design.md` §7 and §9 item 5.

## 1. Intent

Kitty runs today on Docker Compose on the Oracle Always Free server (`kitty`, 2 OCPU / 12 GB,
https://kitty-split.duckdns.org), behind Caddy, with nightly backups. Phase 5a moves it to Kubernetes on that same server,
deployed by GitOps, with the cloud resources described in Terraform.

Why: Kitty has two jobs (parent design §1). For the product, friends keep using the same address with nothing changed
for them. For the showcase, "Kubernetes + GitOps" is one of the skills Kitty exists to add; the owner's other project
already shows Terraform with Azure, so the new things are k3s, Helm, Argo CD, sealed secrets, and Terraform against a
second cloud (Oracle). The owner must be able to explain every line (parent §3), so the cluster stays conventional.

Phase 5 is split: **5a** cluster (this), **5b** OpenTelemetry → Grafana Cloud with alerts, **5c** Trivy + CodeQL,
**5d** Playwright E2E, **5e** k6. 5b's collector runs in this cluster; nothing else depends on 5a.

## 2. Agreed with the owner

- k3s on the existing server, replacing Compose there. Same hostname, same Android default URL.
- **Plain Helm charts** for everything, around official images; no operators (approach A, §4).
- Receipt photos **stay in Azurite**, in the cluster on its own volume. No Azure account; the parent design's
  "Terraform provisions Azure Blob" is dropped (Azure already appears in the owner's other project; real Azure Blob would
  cost a card and only be free for 12 months).
- Cloudflare is dropped from the parent design: it needs a domain the owner owns. DuckDNS + cert-manager instead.
- Terraform **imports** what exists. The server must never be replaced or destroyed by it.
- Cut-over is a few minutes of downtime, with Compose kept (stopped) for a week as the way back.

## 3. Goals, non-goals, anti-goals

**Goals**
- Every Compose service runs in k3s with the same behaviour: `deploy/compose/smoke.sh kitty-split.duckdns.org` passes
  all 16 checks unchanged against the cluster.
- A merge to `main` whose images pass their tests reaches the server with no SSH: CI publishes `sha-<commit>` images,
  writes that tag into `deploy/`, and Argo CD syncs it. `:latest` is no longer used by the server.
- Secrets live in git only as Sealed Secrets.
- `terraform plan` against the real account shows no changes after import.
- Nightly backups keep working (same archive, same bucket), and a restore into the cluster is documented and tested.
- A runbook a person could follow to rebuild the whole thing on a new server from a backup.

**Non-goals**
- High availability, more nodes, autoscaling. One server.
- Monitoring and alerts (5b), image scanning (5c), E2E (5d), load tests (5e).
- Changing any service's code, except where a service can't run in Kubernetes as it is (none expected).
- Local development: Aspire stays as it is. `deploy/compose` stays in the repo as the "run it without the .NET SDK"
  mirror (parent §7), but stops being the production path.

**Anti-goals** (failure even if it works)
- Losing data in the move: anything written before the cut-over must be in the cluster afterwards.
- The Oracle server being destroyed or replaced by a Terraform run (it took ~3,250 attempts to get).
- Any Oracle resource outside Always Free (the account is Pay As You Go with a US$1 budget alert).
- A secret in git in plain text, or in Terraform state.
- Plumbing that nobody can explain: no custom operators, no generated charts nobody reads.
- Weakening what Caddy enforces today (§5.4): the Keycloak admin console or master realm, or reading receipt photos,
  becoming reachable from the internet.

## 4. Approaches (decided: A)

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| A | Plain Helm charts around official images; one Argo CD "app of apps" | Every line readable; we own upgrades and backups (already scripted) | **Chosen** |
| B | Operators for stateful parts (CloudNativePG, Keycloak operator, Redpanda operator) | Managed upgrades/backups; breaks "no custom operators", costs memory, hides what must be explained, and failover means nothing on one node | Rejected |
| C | Managed Postgres/Redis (Neon, Upstash) | Less to run; parent keeps it only as a memory fallback (not needed: ~2 GB used of 12), and Neon free projects sleep when idle | Rejected |

Within A: image tags reach `deploy/` by a CI commit (parent §7), not Argo CD Image Updater (one more controller).
cert-manager, Sealed Secrets and Argo CD are standard, widely used controllers and are accepted; "no custom operators"
is about Kitty's own data services.

## 5. Design

### 5.1 Layout in the repo

```
deploy/
  charts/
    kitty-ledger/  kitty-web/  kitty-ai/  kitty-pulse/      # Kitty's services
    postgres/  keycloak/  redis/  redpanda/  azurite/        # supporting pieces, official images
    kitty-edge/                                              # Traefik routes + middlewares (§5.4), cert-manager Issuer
  apps/                                                      # Argo CD Applications, one per chart + the root app
  values/production/                                         # per-chart values for the server, incl. image tags
  secrets/production/                                        # SealedSecret manifests (encrypted)
  terraform/oracle/                                          # §5.7
  k3s/RUNBOOK.md                                             # replaces deploy/compose/RUNBOOK.md as the production runbook
  compose/                                                   # kept for running without .NET; RUNBOOK points to k3s
```

One chart per service keeps each small enough to read in one sitting. Values carry everything that differs between
environments; there is one environment (production) for now.

### 5.2 The cluster

- k3s (stable channel) on the existing server, single node, with its bundled Traefik, CoreDNS, local-path storage and
  ServiceLB. Namespaces: `kitty` (all of Kitty), `argocd`, `cert-manager`, `kube-system` (Sealed Secrets controller).
- The Kubernetes API (6443) is not opened in Oracle's security list or the server's firewall; the owner's `kubectl`,
  `kubeseal` and port-forwards go through an SSH tunnel (`ssh -L 6443:127.0.0.1:6443`).
- Storage: `local-path` PersistentVolumes on the boot volume (89 GB free) for Postgres, Redpanda and Azurite. No new
  block volumes (Always Free allows 200 GB in all, the boot volume already uses 100).
- Resource requests/limits carry over from Compose (`deploy.resources.limits`): Postgres 1 GiB, Keycloak 1 GiB,
  Redpanda 1.5 GiB, ai 1.5 GiB, ledger 512 MiB, web 512 MiB, Azurite 256 MiB, pulse 128 MiB, Redis 64 MiB.
  Measured use today is about 2 GB for the whole stack; k3s, Argo CD (single replica, no Dex), cert-manager and Sealed
  Secrets add roughly 1.5–2 GB. During the side-by-side period (§5.8) both stacks run: still well under 12 GB.
- Health: the Compose healthchecks become readiness/liveness probes (`pg_isready`, `redis-cli ping`,
  `rpk cluster health`, ai `/health`, pulse `-health`; ledger `/health`, Keycloak's health endpoint). Start-up order
  comes from probes plus init containers that wait for their dependency (e.g. ledger waits for Postgres and pulse),
  not from Argo CD sync order alone.
- The one-shot `ai-db-setup` and `pulse-db-setup` become Kubernetes Jobs run as Argo CD sync hooks (they are idempotent
  and run on every start today), before ai and pulse start.

### 5.3 Same issuer inside and outside

Today Compose gives Caddy a network alias equal to the public hostname, so the web app, ledger and ai reach Keycloak at
the same `https://<host>/auth/realms/kitty` issuer browsers see. In the cluster, CoreDNS resolves
`kitty-split.duckdns.org` to Traefik's in-cluster Service (k3s `coredns-custom` ConfigMap), so pods reach the public
URL without leaving the node and the certificate is still valid. Hairpinning through Oracle's public IP is not relied on.

### 5.4 Edge: Traefik routes that match the Caddyfile

`kitty-edge` holds Traefik `IngressRoute`s and `Middleware`s (Traefik's own CRDs, bundled with k3s) reproducing
`deploy/compose/Caddyfile` rule for rule:

| Path | Goes to | Rules |
|---|---|---|
| `/auth/realms/kitty`, `/auth/realms/kitty/*`, `/auth/resources/*` | keycloak:8080 | no `;` anywhere in the path; everything else under `/auth` → 404 |
| `/api/auth/*` | web:3000 | (Auth.js lives inside the `/api` prefix) |
| `PUT /blob/*` | azurite:10000, `/blob` stripped | body ≤ 11 MB; any other method under `/blob` → 404 |
| `/.well-known/oauth-protected-resource*` | ai:8000 | path kept |
| `/ai/*` | ai:8000, `/ai` stripped | |
| `/api/*` | ledger:8080, `/api` stripped | WebSockets (SignalR) pass |
| everything else | web:3000 | |

Plus: HTTP→HTTPS redirect; HSTS, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, no `Server` header;
compression. Encoded traversal (`%2e%2e`) and `..;` must be refused exactly as `smoke.sh` checks; Traefik's own handling
of encoded characters is not assumed, the smoke test is the judge.

Client addresses: the web app's guest-join limit uses the caller's IP (`TRUST_PROXY_HEADERS`), so Traefik's Service uses
`externalTrafficPolicy: Local` (or equivalent) and real client IPs reach the apps, not the node's.

TLS: cert-manager with a Let's Encrypt `ClusterIssuer` (HTTP-01 through Traefik) for `kitty-split.duckdns.org`.

The Keycloak admin console stays off the internet; it is reached with `kubectl port-forward svc/keycloak 8180:8080`
(`KC_HOSTNAME_ADMIN` stays `http://localhost:8180/auth`), replacing the SSH tunnel.

### 5.5 Secrets

- Sealed Secrets controller in `kube-system`. Every value in today's `.env` that is secret (Postgres, Keycloak admin,
  `AUTH_SECRET`, client secrets, Azurite key, ai/pulse DB passwords, SMTP, Gemini key, Firebase key file when added) becomes
  a `SealedSecret` in `deploy/secrets/production/`, sealed with `kubeseal` from the owner's PC against the controller's
  public key. Non-secret settings (`KITTY_HOST`, SMTP host/port, image prefix) are plain values.
- **The repo is public, so personal details are sealed too**, even when not secret: the Gmail address (`SMTP_USER`,
  `SMTP_FROM`) goes in a SealedSecret, never a values file.
- **The controller's private key is the one thing that can open them.** After install, its key is exported once and
  kept off the server, alongside the owner's other keys (the runbook says where and how to restore it). Without it, a
  rebuilt server can't read the secrets in git; with it, a rebuild is: install controller with the old key, sync.
- The Gemini key and the Gmail app password are sealed by the owner (they type them into `kubeseal`); the builder
  never sees or handles them. Generated secrets move from the server's `.env` to sealed form without being printed.

### 5.6 GitOps flow

- Argo CD (official Helm chart, one replica per component, Dex and notifications off) in `argocd`. Its UI is reached by
  `kubectl port-forward`; not exposed.
- A root Application (`deploy/apps/root.yaml`) points at `deploy/apps/`, which holds one Application per chart with its
  values file. Auto-sync with prune and self-heal on for Kitty's charts; the stateful charts (Postgres, Redpanda,
  Azurite) keep their PersistentVolumeClaims if an Application is ever deleted (`helm.sh/resource-policy: keep` or
  Argo CD's equivalent), so a mistake in git can't delete data.
- Argo CD reads the public GitHub repo over HTTPS; no deploy key needed.
- CI: after `images.yml` pushes `sha-<commit>` images (only images whose tests passed, as today), a follow-up job writes
  that tag into `deploy/values/production/*` and commits it to `main` as a bot commit. That commit must not trigger the
  image build again (path filter or `[skip ci]`). Argo CD picks it up within its poll interval (default 3 min).
  `main` has no branch protection and no rulesets (checked 2026-11-27), so the job's `GITHUB_TOKEN` with
  `contents: write` can push. If protection is added later, this job must be revisited, not given a bypass silently.
- Rolling back = reverting the tag commit.
- Image tags are the `sha-` tags already pushed; the images stay public on GHCR.

### 5.7 Terraform (Oracle)

- `deploy/terraform/oracle/`, OCI provider, run from the owner's PC (where the OCI CLI is already configured). CI only
  runs `terraform fmt -check` and `terraform validate`; it never applies.
- Imports what exists, so the first `plan` after import is empty: the `kitty` instance, its VCN, subnet, internet
  gateway, route table and security list (22/80/443), the `kitty-cost-guard` budget and its alert rule, the
  `kitty-backups` bucket with its lifecycle rule, and the `kitty-backups-lifecycle` IAM policy.
- The instance (and its boot volume) has `lifecycle { prevent_destroy = true }`, and attributes that would force a
  replacement on a harmless change (image OCID, metadata/user data, shape config) are in `ignore_changes`. A plan that
  would replace the server is a bug in the Terraform, never applied.
- Not in Terraform: the write-only upload link (its URL would sit in state), DuckDNS (no provider; the IP is static
  while the server runs), the API keys.
- State: kept in the `kitty-backups` bucket's account, in its own private bucket (`kitty-tfstate`, Always Free storage),
  through Terraform's OCI/S3-compatible backend, never in git. State may hold resource IDs, not secrets (above).
- Personal or account-identifying values (tenancy and compartment OCIDs, the budget alert's email address) are Terraform
  variables set in a git-ignored `terraform.tfvars` on the owner's PC; a committed `terraform.tfvars.example` has
  placeholders. The public repo never holds them.
- The public IP is **ephemeral** (checked 2026-11-27: the account has no reserved public IPs), despite the Compose
  runbook's "reserve the IP" step, which was never done. It stays ephemeral: it survives reboots and only changes if the
  instance is stopped, and reserving may not be free. Terraform doesn't manage it; the k3s runbook says what to do if it
  ever changes (update DuckDNS), and the Compose runbook's step is corrected.

### 5.8 Cut-over

1. Install k3s with its ServiceLB/Traefik **not** on 80/443 yet (Caddy holds them). Install cert-manager, Sealed
   Secrets, Argo CD; sync everything. Postgres starts empty. Until the switch, the cluster's SMTP and push settings are
   off, so its pulse can't email or notify real people (its copy of the data is a rehearsal and is discarded).
2. Get the **real** certificate into the cluster before the switch: the live Caddyfile temporarily forwards
   `/.well-known/acme-challenge/*` to Traefik's alternate HTTP port, so cert-manager's HTTP-01 challenge succeeds while
   Caddy keeps serving everything else. (Caddy's own certificate was issued 2026-11-27 and won't renew for ~60 days,
   so its challenges don't collide; Let's Encrypt's duplicate-certificate limit allows it.) With a real certificate,
   the pods' issuer fetches through CoreDNS (§5.3) work in the rehearsal. The Caddy change is confirmed with the owner
   when it's made, and removed at the switch.
3. Rehearse: restore last night's backup into the cluster (§5.9) and run `smoke.sh` against the alternate HTTPS port
   (curl `--resolve`). Compare row counts and every group's balances between Compose's Postgres and the cluster's by SQL.
   A browser sign-in can't be rehearsed (the issuer and redirect URLs carry no port, so a browser always reaches
   Caddy); it is checked right after the switch, with the way back below if it fails.
4. The switch, minutes of downtime: stop Compose's `web`, `ledger`, `ai`, `pulse` and `keycloak` (no more writes), take
   a **fresh** backup with `backup.sh`, restore it into the cluster, stop Compose entirely, move Traefik to 80/443,
   turn the cluster's SMTP and push on, run `smoke.sh kitty-split.duckdns.org` (all 16), sign in in a browser.
5. Way back for a week: `docker compose up -d` brings Compose back with its data as it was at the switch (writes made
   in the cluster since then would need a backup/restore the other way; the runbook says so). After a week without
   problems, Compose's volumes and Docker are removed.

### 5.9 Backups

- `backup.sh` keeps its archive format (`globals.sql`, `ledger.dump`, `keycloak.dump`, `azurite.tar.gz`) and upload, and
  switches `docker exec <container>` for `kubectl exec` into the Postgres and Azurite pods (by label, namespace `kitty`).
  The cron entry, retention and the write-only link are unchanged.
- The runbook's restore steps are rewritten for the cluster (scale Kitty's Deployments to 0, restore, scale back), and
  the restore is done for real once during the rehearsal (§5.8 step 3).
- Not backed up: Redpanda (event log, rebuilt), certificates (reissued), Argo CD state (rebuilt from git).
  **Backed up separately, once:** the Sealed Secrets key (§5.5).

### 5.10 Checks

- CI on PRs touching `deploy/charts` or `deploy/values`: `helm lint` and `helm template` every chart with its production
  values, then validate the output with `kubeconform` (including Traefik/cert-manager/Argo CD CRDs). Optional, builder's
  call: install the charts into a throwaway k3d cluster in CI and run `smoke.sh --insecure` against it.
- On the server after every change of the edge or a chart: `smoke.sh kitty-split.duckdns.org`.
- The end of 5a is judged on the server: all 16 smoke checks, sign-in, a receipt upload, an expense with a foreign
  currency (pulse), a plain-language sentence (ai), MCP discovery, a backup and a restore rehearsal.

## 6. Constraints

- Oracle Always Free only: A1 2 OCPU / 12 GB, 200 GB block storage, 20 GB Object Storage. PAYG account; the US$1 budget
  alert must stay quiet.
- No secrets in source or Terraform state; the Gemini key and Gmail app password are handled only by the owner.
- Any command that changes the server, Oracle resources or data is confirmed with the owner first (global rule).
- No new dependencies in Kitty's services. New tools are deployment-side only: k3s, Helm, Argo CD, cert-manager,
  Sealed Secrets (`kubeseal`), Terraform, kubeconform.
- The Android app's default URL and the web address don't change.

## 7. Left to the builder

- Exact chart structure and template helpers (keep them small and readable), probe timings, init-container images.
- Versions: latest stable of k3s, Argo CD, cert-manager, Sealed Secrets, Terraform and the OCI provider at build time,
  pinned.
- How Traefik is held off 80/443 during the rehearsal (alternate entrypoint ports or a disabled ServiceLB until the
  switch), as long as Compose keeps serving until step 3.
- Whether the tag-bump commit is done by `GITHUB_TOKEN` or a fine-grained token, as long as it can't loop.
- The Terraform state backend details, within "private bucket, Always Free, not in git".
- Whether CI also installs into k3d (§5.10).
