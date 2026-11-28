# Running Kitty on k3s (Oracle Always Free)

One small ARM server (`kitty`, A1 2 OCPU / 12 GB) runs a single-node k3s cluster. Argo CD keeps it matching
`deploy/` on `main`. Cost: R0. The design is `docs/superpowers/specs/2026-11-27-kitty-phase5a-k3s-design.md`.

```
browser ──https──► Traefik (k3s) ─┬─ /auth/realms/kitty…  → keycloak   (admin console and master realm: 404)
                                  ├─ /api/auth/*          → web        (Auth.js)
                                  ├─ /api/*               → ledger     (public API, live table WebSocket)
                                  ├─ PUT /blob/*          → azurite    (receipt uploads only; reading: 404)
                                  ├─ /ai/*, /.well-known/oauth-protected-resource* → ai
                                  └─ /*                   → web
in the cluster: postgres, redis, redpanda, pulse; cert-manager (Let's Encrypt), Sealed Secrets, Argo CD
```

| Where | What |
|---|---|
| `deploy/charts/<name>` | one Helm chart per piece (official images) |
| `deploy/values/production/<name>.yaml` | the server's settings, including Kitty's image tags |
| `deploy/apps` | Argo CD's Applications (app of apps); `deploy/k3s/root-app.yaml` is the root |
| `deploy/secrets/production` | the sealed settings (`kitty-secrets`) |
| `deploy/terraform/oracle` | the Oracle server, network, budget and backups bucket |
| `deploy/tests` | chart tests, schema checks, and the k3d end-to-end run CI does on every PR |

## Reaching the cluster

The Kubernetes API (6443) is not open to the internet. Tunnel it over SSH, then use `kubectl` from your PC:

```bash
ssh -i ~/.ssh/kitty_oracle -N -L 6443:127.0.0.1:6443 ubuntu@<server>
# once: copy the kubeconfig (its server is https://127.0.0.1:6443, which the tunnel serves)
scp -i ~/.ssh/kitty_oracle ubuntu@<server>:.kube/config ~/.kube/kitty && export KUBECONFIG=~/.kube/kitty
```

- Argo CD UI: `kubectl -n argocd port-forward svc/argocd-server 8081:80`, then http://localhost:8081 (user `admin`,
  password: `kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d`).
- Keycloak admin console: `kubectl -n kitty port-forward svc/keycloak 8180:8080`, then
  http://localhost:8180/auth/admin (user `admin`, password `KEYCLOAK_ADMIN_PASSWORD` from the server's `.env`).
- What's running: `kubectl -n argocd get applications`, `kubectl -n kitty get pods`.

## How a change reaches the server

1. A PR merges to `main`. `images.yml` tests and publishes the four images as `sha-<commit>`.
2. Its `deploy-tag` job runs `deploy/k3s/set-image-tag.sh sha-<commit>` and commits that to `main` (`[skip ci]`).
3. Argo CD notices within about 3 minutes and rolls it out. Chart or values changes merged to `main` roll out the
   same way.

**Rolling back:** revert the tag commit (or set the older tag with `set-image-tag.sh` in a PR). Argo CD rolls back.
Check after any change with `deploy/compose/smoke.sh kitty-split.duckdns.org` (16 checks).

## Settings and secrets

Secret settings live in git only as a SealedSecret, which only this cluster's Sealed Secrets controller can open.
To change one, edit `~/kitty/deploy/compose/.env` on the server (it stays the source), then **on the server**:

```bash
deploy/k3s/seal-env.sh ~/kitty/deploy/compose/.env > kitty-secrets.yaml
```

Copy `kitty-secrets.yaml` into `deploy/secrets/production/` in a PR. Pods read secrets at start, so after it syncs:
`kubectl -n kitty rollout restart deployment`. (Keycloak reads SMTP and client secrets into its realm only on its
very first start; changing those later is done in its admin console.)

Non-secret settings are in `deploy/values/production/`. Email and push from pulse are switched with
`notifications.enabled` in `kitty-pulse.yaml`.

### The Sealed Secrets key (keep it safe)

The controller's private key is the only thing that can open the sealed settings. Export it once after installing,
keep it off the server (a password manager or an encrypted file on your PC), and never commit it:

```bash
kubectl -n kube-system get secret -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml > sealed-secrets-key.yaml
```

On a rebuilt cluster, apply it **before** Argo CD installs the controller (or restart the controller after):
`kubectl apply -f sealed-secrets-key.yaml && kubectl -n kube-system rollout restart deployment sealed-secrets-controller`.
Without it, re-seal from `.env` with `seal-env.sh`.

## Backups

`deploy/compose/backup.sh` runs every night at 01:17 UTC from `/etc/cron.d/kitty-backup`, reading the cluster:

```
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
17 1 * * * ubuntu KITTY_BACKUP_TARGET=k3s KUBECONFIG=/home/ubuntu/.kube/config /home/ubuntu/kitty/deploy/compose/backup.sh >> /home/ubuntu/kitty-backups/backup.log 2>&1
```

Same archive and bucket as before (Postgres roles, `ledger` and `keycloak` databases, receipt photos); the server
keeps 7, Object Storage keeps 30 days. Setup of the bucket and upload link: `deploy/compose/RUNBOOK.md`, "Backups".

**Restore** (stops the apps, replaces the data, starts them):

```bash
deploy/k3s/restore.sh ~/kitty-backups/kitty-<time>.tar.gz
deploy/compose/smoke.sh kitty-split.duckdns.org
```

A copy from Object Storage: `oci os object get --bucket-name kitty-backups --name <name> --file <name>`.
Not backed up: Redpanda (an event log, rebuilt), certificates (reissued), Argo CD (rebuilt from git), and the Sealed
Secrets key (kept separately, above).

## Building the server from nothing

1. Server, network, budget and bucket: Terraform (below) describes them; if the server is gone, create it as
   `deploy/compose/RUNBOOK.md` section 1 says (iptables included), then point DuckDNS at its IP.
2. k3s, pinned to the version CI tests, with its settings from `deploy/k3s/config.yaml`:
   ```bash
   sudo mkdir -p /etc/rancher/k3s && sudo cp ~/kitty/deploy/k3s/config.yaml /etc/rancher/k3s/config.yaml
   curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=v1.37.2+k3s1 sh -s -
   mkdir -p ~/.kube && sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config && sudo chown ubuntu: ~/.kube/config
   ```
   (Next to a running Compose, use `config-alongside-compose.yaml` instead: see "The switch from Compose".)
3. Helm and `kubeseal` on the server (pinned releases, checksums checked), and a clone of this repository at `~/kitty`.
4. The Sealed Secrets key, if you have it (above). Then `deploy/k3s/bootstrap.sh main`. Argo CD installs
   cert-manager, Sealed Secrets and every chart; Postgres starts empty.
5. If you had no key: re-seal from `.env` (above) and merge it.
6. `deploy/k3s/restore.sh <newest backup>`, then `deploy/compose/smoke.sh kitty-split.duckdns.org`.

## Terraform

`deploy/terraform/oracle` describes the Oracle resources Kitty uses. Run it from your PC only (CI just validates):

```bash
cd deploy/terraform/oracle
cp terraform.tfvars.example terraform.tfvars        # fill in (git-ignored): OCIDs from the OCI CLI
echo 'namespace = "<oci os ns get>"' > backend.hcl  # git-ignored
terraform init -backend-config=backend.hcl
terraform plan
```

State is in the private bucket `kitty-tfstate` (created once by hand: `oci os bucket create --name kitty-tfstate
--compartment-id <tenancy OCID>`). **A plan that would destroy or replace the server is a bug in the code: never
apply it.** `prevent_destroy` makes Terraform refuse such a plan anyway. The upload link for backups, DuckDNS and the
API keys are deliberately outside Terraform.

## Observability (Grafana Cloud)

Every service (ledger, ai, pulse, web) sends traces and metrics over OTLP to one OpenTelemetry Collector in the
`observability` namespace (`otel-collector.observability:4318`). The collector also reads Kitty's pod logs, collects
node, pod and cluster health, and scrapes cert-manager, Traefik and itself. It **scrubs** everything, then forwards it
to Grafana Cloud's free tier. Design: `docs/superpowers/specs/2026-11-28-kitty-phase5b-observability-design.md`.

**What never leaves the server** (`deploy/values/production/otel-collector.yaml`, proven by
`deploy/tests/test_scrub.py`):
- email addresses, tokens (JWTs, bearer, API keys, app passwords), invite links;
- client IP addresses, raw paths and full URLs, query strings;
- SQL text and request bodies;
- personal values inside span names, exception messages and stack traces, and Keycloak's login events (usernames,
  names); span status messages are blanked.

Traefik's access log, CoreDNS and Argo CD's logs aren't shipped at all; only namespace `kitty`'s logs are. Only the
metrics the dashboard and alerts read are kept (a keep-list in `filter/noise`), which holds the free tier's series
budget; add a metric's name there before building a panel on it.

**Setting it up** (once):
1. Create a free Grafana Cloud account (no payment method) and a stack in the region nearest South Africa.
2. In the stack, under OpenTelemetry, create a token for sending data. Note the OTLP endpoint, the instance id and
   the token, and add them to the server's `~/kitty/deploy/compose/.env` as `GRAFANA_OTLP_ENDPOINT`,
   `GRAFANA_OTLP_INSTANCE_ID` and `GRAFANA_OTLP_TOKEN`.
3. On the server: `deploy/k3s/seal-env.sh ~/kitty/deploy/compose/.env --grafana > grafana-cloud.yaml`, then commit
   `grafana-cloud.yaml` into `deploy/secrets/production/`. Until it's there, the collector pod waits and the services'
   exports are simply dropped.
4. In the stack, under Administration, create a service account with the Editor role, and a token for it.
5. Dashboard and alerts, from your PC:
   ```bash
   cd deploy/terraform/grafana
   cp terraform.tfvars.example terraform.tfvars        # stack URL, service-account token, alert email (git-ignored)
   echo 'namespace = "<oci os ns get>"' > backend.hcl  # git-ignored; same state bucket as Oracle's
   terraform init -backend-config=backend.hcl
   terraform plan && terraform apply
   ```

**The alerts** (emailed to you; `deploy/terraform/grafana/alerts.tf`):

| Alert | What it means | First thing to do |
|---|---|---|
| `error-rate` | over 5% of a service's requests failed (5xx) for 10 minutes | `kubectl -n kitty logs deploy/kitty-<service>` |
| `pod-unhealthy` | a Kitty pod hasn't been ready, or has restarted twice or more, for 10 minutes | `kubectl -n kitty describe pod <pod>`, then its logs |
| `backup-missing` | no successful nightly backup for 26 hours | `tail ~/kitty-backups/backup.log` on the server |
| `certificate-expiring` | the HTTPS certificate expires within 14 days | `kubectl -n kitty describe certificate kitty-tls` |
| `collector-silent` | no telemetry for 15 minutes | `kubectl -n observability get pods`, then its logs |

**Locally**, Aspire's dashboard receives the same telemetry (`http://localhost:18888`; the services send to its
OTLP endpoints on 18889 and 18890). With no `OTEL_EXPORTER_OTLP_ENDPOINT` set, nothing is exported anywhere.

**Client addresses** (the web app's guest-join limit uses them): check on the node, never in Grafana. Request the site
from outside, then look at the newest line of `kubectl -n kube-system logs deploy/traefik`. Its first field must be
the caller's public address, not a `10.x` one. If it's internal, switch Traefik to `hostPort` in the HelmChartConfig
(`deploy/charts/kitty-edge/templates/cluster.yaml`).

## The public IP

The server's IP is ephemeral: it survives reboots and only changes if the instance is stopped from Oracle's console.
If it ever changes, update the DuckDNS name to the new IP (https://www.duckdns.org). Nothing else refers to it.

## The switch from Compose (2026-11)

Kitty moved from Docker Compose to k3s on this same server, with Compose kept stopped for a week as the way back:

- **Before the switch**, Caddy (Compose) held 80/443, so k3s ran with `deploy/k3s/config-alongside-compose.yaml`:
  ServiceLB off, because its hostPorts are iptables rules that would have taken 80/443 from Caddy the moment k3s
  started. Traefik was reachable on its NodePorts 30080/30443 at the server's private address. Caddy forwarded
  `/.well-known/acme-challenge/*` to `<private address>:30080` so the cluster got its real certificate, and the
  rehearsal ran `deploy/compose/smoke.sh kitty-split.duckdns.org --connect-to <private address>:30443`,
  `deploy/k3s/restore.sh` and `deploy/k3s/compare-data.sh` against a restored backup. The cluster's notifications were
  off. Right after installing k3s, `curl -sI https://kitty-split.duckdns.org` still had to answer from Caddy.
- **The switch:** stop Compose's writers, `backup.sh` (Compose target), `restore.sh <archive> --no-start`,
  `compare-data.sh` (identical), stop Compose, put `config.yaml` in place of the alongside file and
  `sudo systemctl restart k3s` (ServiceLB now serves 80/443), start the apps, notifications on, smoke checks, a
  browser sign-in.
- **Way back** (only while Compose's volumes still exist): stop k3s and remove its network rules, then start Compose:
  ```bash
  sudo systemctl stop k3s && sudo /usr/local/bin/k3s-killall.sh
  docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env up -d
  ```
  Compose has its data as it was at the switch; anything written in the cluster since needs `backup.sh` (k3s target)
  and a Compose restore.
