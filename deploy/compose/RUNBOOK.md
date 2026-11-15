# Deploying Kitty on Oracle Always Free (phase 1)

One small ARM server runs everything with Docker Compose: Postgres, Keycloak, the ledger, the web
app and Caddy (automatic HTTPS). Cost: R0. Phase 5 replaces this with k3s, Helm and Argo CD.

```
browser ──https──► Caddy ─┬─ /auth/*  → Keycloak  (admin console blocked; SSH tunnel only)
                          ├─ /api/*   → ledger    (public API for the mobile app later)
                          └─ /*       → web       (Next.js; calls the ledger internally)
```

## 1. Create the server (once)

1. Oracle Cloud console → Compute → Instances → Create.
   - Image: Ubuntu 24.04. Shape: **VM.Standard.A1.Flex, 2 OCPU, 12 GB**.
   - **Stay within 2 OCPU / 12 GB in total.** Since June 2026 that is the whole Always Free
     allowance; going over gets every A1 instance disabled.
   - If A1 capacity is unavailable in your region, retry later or try another availability domain.
2. Networking → reserve the instance's public IP (so it never changes).
3. VCN → security list → add ingress rules for TCP **80** and **443** from `0.0.0.0/0`.
4. Oracle's Ubuntu image also blocks ports with iptables. On the server:
   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```
5. Install Docker: <https://docs.docker.com/engine/install/ubuntu/> and add your user to the `docker` group.

## 2. Hostname (free)

Create a name at <https://www.duckdns.org> (e.g. `kitty-yourname.duckdns.org`) and point it at the
reserved IP. The IP is static, so no updater is needed.

## 3. Email for verification links

Keycloak requires email verification (it stops account takeover through Google sign-in).
Create a free Resend account, verify a sending domain or use their test domain, create an API key,
and put it in `SMTP_PASSWORD`.

## 4. Configure and start

```bash
git clone <your repo url> kitty && cd kitty
cp deploy/compose/.env.example deploy/compose/.env
nano deploy/compose/.env        # fill every value; generate secrets with: openssl rand -base64 32
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env pull
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env up -d
deploy/compose/smoke.sh kitty-yourname.duckdns.org
```

If the GHCR packages are private, either make them public in GitHub (Packages → settings) or run
`docker login ghcr.io` on the server with a read-only token first.

## 5. Updating

CI pushes images tagged `sha-<commit>` and `latest` on every push to `main`.

```bash
git pull
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env pull
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env up -d
deploy/compose/smoke.sh kitty-yourname.duckdns.org
```

Pin `KITTY_TAG=sha-…` to roll back to a known build.

## Keycloak admin console

It is not reachable from the internet. From your own machine:

```bash
ssh -L 8180:127.0.0.1:8180 ubuntu@<server-ip>
# then open http://localhost:8180/auth/admin  (user: admin, password: KEYCLOAK_ADMIN_PASSWORD)
```

The realm is imported from `infra/keycloak/kitty-realm.json` only on the very first start.
Later realm changes are made in the admin console (or by re-importing deliberately).

## Backups

Everything that matters is in the `kitty_pgdata` volume:

```bash
docker compose -f deploy/compose/docker-compose.yml exec postgres pg_dumpall -U postgres | gzip > kitty-$(date +%F).sql.gz
```

Copy the file off the server (e.g. to Oracle Object Storage, also free up to 20 GB).
