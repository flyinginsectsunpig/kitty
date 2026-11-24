# Deploying Kitty on Oracle Always Free

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

- **DuckDNS name (no domain of your own):** use Gmail. Turn on 2-Step Verification on the Google account,
  create an app password at https://myaccount.google.com/apppasswords (name it "Kitty"), and set
  `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER` and `SMTP_FROM` to that Gmail address, and
  `SMTP_PASSWORD` to the app password. Gmail allows about 500 emails a day.
- **Your own domain:** Resend's free tier works too, once the domain is verified there (it needs DKIM/SPF
  DNS records, which a DuckDNS name can't have): `SMTP_HOST=smtp.resend.com`, `SMTP_USER=resend`,
  `SMTP_PASSWORD` = the API key, `SMTP_FROM` on the verified domain.

## 3a. Receipt scanning

Optional: create a free API key in Google AI Studio and put it in `GEMINI_API_KEY`. Photos never leave the server:
the ai service reads the text itself, removes card numbers, phone numbers and staff names, and sends only
that text to Gemini's free tier (Google may use it to improve its products; the app says so next to the
scan button). Without a key the scan button still uploads, then tells the host to type the items.

Receipt photos are stored in Azurite on the server (`BLOB_ACCOUNT_KEY` protects them) and deleted 90 days
after the bill closes. To use a real Azure storage account instead, set `BLOB_CONNECTION_STRING` to its
connection string, set `BLOB_PUBLIC_URL=` (empty, so browsers upload to Azure directly), and add a CORS
rule on the account allowing `PUT` from `https://<your host>`.

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

**Upgrading to receipt scanning (phase 2b):** add `BLOB_ACCOUNT_KEY` (`openssl rand -base64 32`) and
`AI_DB_PASSWORD` (`openssl rand -hex 24`) to `.env` before `up`; compose refuses to start without them.
`GEMINI_API_KEY` stays optional.

**Upgrading to recurring expenses (phase 3b):** add `PULSE_CLIENT_SECRET` (`openssl rand -hex 24`) to `.env`.
A fresh install needs nothing else: compose passes it to Keycloak, whose realm import gives the `kitty-pulse` client
that secret. Keycloak imports the realm only once, though, so an existing server lacks pulse's client. Add it:
1. Copy the `kitty-pulse` object (the whole `{ … }` from the `clients` list in `infra/keycloak/kitty-realm.json`) into
   a file of its own, e.g. `kitty-pulse.json`.
2. Admin console → realm `kitty` → Clients → Import client → choose that file → Save.
3. Clients → `kitty-pulse` → Credentials: set the client secret to exactly the `PULSE_CLIENT_SECRET` from `.env`
   (the import leaves the literal `${…}` placeholder there; don't use Regenerate, which picks a random one).
4. `docker compose … up -d` so pulse picks it up. Check `docker compose logs pulse`: no "service token" warnings.

The ledger now also listens on 8082 inside the compose network for pulse; Caddy doesn't route it.

**Upgrading to exchange rates (phase 3a):** add `PULSE_DB_PASSWORD` (`openssl rand -hex 24`) to `.env` before
`up`. The new `pulse` service (a small Go binary, capped at 128 MB) answers the ledger's rate lookups; it needs outbound HTTPS to
`api.frankfurter.dev`. If pulse is down, expenses still save (without a rate) and foreign payments ask for one.

**Upgrading to the Android app (phase 2c):** Keycloak imports `infra/keycloak/kitty-realm.json` only when the
realm doesn't exist yet (`--import-realm`), so a server set up before 2c lacks the app's `kitty-mobile` client. Add
it once in the admin console (see below): Clients → Import client → pick the `kitty-mobile` entry from the realm file
(public client, standard flow, PKCE S256, redirect `kitty://auth/callback`, the `kitty-ledger` audience mapper).
A fresh server gets it automatically.

## 5a. The Android app

Download the APK from the repository's GitHub Releases (`mobile-v*` tags) or from the latest `android` workflow run,
and open it on the phone (allow installs from that source when asked). Building it is described in
[apps/mobile/README.md](../../apps/mobile/README.md). Once you have the signing certificate's SHA-256, set
`ANDROID_CERT_SHA256` in `.env` and `up -d` again: invite and table links then open in the installed app.

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
