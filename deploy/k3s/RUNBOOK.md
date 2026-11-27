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
17 1 * * * ubuntu KITTY_BACKUP_TARGET=k3s /home/ubuntu/kitty/deploy/compose/backup.sh >> /home/ubuntu/kitty-backups/backup.log 2>&1
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
2. k3s, pinned to the version CI tests:
   ```bash
   curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=v1.37.2+k3s1 sh -s - --write-kubeconfig-mode 0600
   mkdir -p ~/.kube && sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config && sudo chown ubuntu: ~/.kube/config
   ```
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

## The public IP

The server's IP is ephemeral: it survives reboots and only changes if the instance is stopped from Oracle's console.
If it ever changes, update the DuckDNS name to the new IP (https://www.duckdns.org). Nothing else refers to it.

## The switch from Compose (2026-11)

Kitty moved from Docker Compose to k3s on this same server, with Compose kept stopped for a week as the way back:

- **Before the switch**, Caddy (Compose) held 80/443. Traefik was reachable on NodePorts 30080/30443, Caddy forwarded
  `/.well-known/acme-challenge/*` to 30080 so the cluster got its real certificate, and the rehearsal ran
  `deploy/compose/smoke.sh kitty-split.duckdns.org --connect-to 127.0.0.1:30443` and
  `deploy/k3s/compare-data.sh` against a restored backup. The cluster's notifications were off.
- **The switch:** stop Compose's writers, `backup.sh` (Compose), `restore.sh` into the cluster, `compare-data.sh`,
  stop Compose, Traefik takes 80/443, notifications on, smoke checks, a browser sign-in.
- **Way back** (only while Compose's volumes still exist): stop Traefik from serving 80/443
  (`kubectl -n kube-system scale deployment traefik --replicas=0`), then
  `docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env up -d`. Compose has its data as
  it was at the switch; anything written in the cluster since needs `backup.sh` (k3s) and a Compose restore.
