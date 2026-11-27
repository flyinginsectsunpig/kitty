# Deploying Kitty on Oracle Always Free

One small ARM server runs everything with Docker Compose: Postgres, Keycloak, the ledger, the web
app and Caddy (automatic HTTPS). Cost: R0.

> **Production now runs on k3s: see `deploy/k3s/RUNBOOK.md`.** This Compose setup stays for running Kitty on one
> machine without the .NET SDK. Its server setup (section 1), email (3) and backup bucket steps still apply.

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
2. The instance's public IP is ephemeral: it survives reboots and only changes if the instance is stopped. Kitty's
   server keeps it that way (reserving one may not be free); if it ever changes, update DuckDNS.
3. VCN → security list → add ingress rules for TCP **80** and **443** from `0.0.0.0/0`.
4. Oracle's Ubuntu image also blocks ports with iptables. The new rules must go **above** its final `REJECT` rule
   (check its position with `sudo iptables -L INPUT --line-numbers -n`; on Ubuntu 24.04 it is rule 5):
   ```bash
   sudo iptables -I INPUT 5 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 5 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```
5. Install Docker: <https://docs.docker.com/engine/install/ubuntu/> and add your user to the `docker` group.

## 2. Hostname (free)

Create a name at <https://www.duckdns.org> (e.g. `kitty-yourname.duckdns.org`) and point it at the
server's IP. It only changes if the instance is stopped, so no updater is needed.

## 3. Email for verification links

Keycloak requires email verification (it stops account takeover through Google sign-in).

- **DuckDNS name (no domain of your own):** use Gmail. Turn on 2-Step Verification on the Google account,
  create an app password at https://myaccount.google.com/apppasswords (name it "Kitty"), and set
  `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER` and `SMTP_FROM` to that Gmail address, and
  `SMTP_PASSWORD` to the app password. Gmail allows about 500 emails a day.
- **Your own domain:** Resend's free tier works too, once the domain is verified there (it needs DKIM/SPF
  DNS records, which a DuckDNS name can't have): `SMTP_HOST=smtp.resend.com`, `SMTP_USER=resend`,
  `SMTP_PASSWORD` = the API key, `SMTP_FROM` on the verified domain.

Notification emails (section 3b) go out through the same account, from "Kitty <SMTP_FROM>".

## 3a. Receipt scanning

Optional: create a free API key in Google AI Studio and put it in `GEMINI_API_KEY`. Photos never leave the server:
the ai service reads the text itself, removes card numbers, phone numbers and staff names, and sends only
that text to Gemini's free tier (Google may use it to improve its products; the app says so next to the
scan button). Without a key the scan button still uploads, then tells the host to type the items.

Receipt photos are stored in Azurite on the server (`BLOB_ACCOUNT_KEY` protects them) and deleted 90 days
after the bill closes. To use a real Azure storage account instead, set `BLOB_CONNECTION_STRING` to its
connection string, set `BLOB_PUBLIC_URL=` (empty, so browsers upload to Azure directly), and add a CORS
rule on the account allowing `PUT` from `https://<your host>`.

## 3b. Notifications

pulse tells people when they're added to an expense or a payment with them is recorded, and on Mondays what they
owe. Each person picks push and/or email for each in Settings → Notifications (push for expenses and payments is on
by default; email only reaches a verified address). Email needs nothing beyond section 3.

Push (the Android app) needs a free Firebase project, once:

1. In the [Firebase console](https://console.firebase.google.com), add a project (Analytics not needed), then add an
   Android app with package name `za.kitty.app`. Download its `google-services.json`: that goes into the app build
   (see [apps/mobile/README.md](../../apps/mobile/README.md), "Push notifications").
2. Project settings → Service accounts → Generate new private key. Copy the file to the server as
   `deploy/compose/secrets/fcm.json` (readable by the container: `chmod 644`), and set
   `PULSE_FCM_CREDENTIALS=/secrets/fcm.json` in `.env`. Keep it secret: it can send push to every Kitty phone.
3. `docker compose up -d pulse`. Its log no longer says "push notifications are off".

Phones register when someone signs in to an APK built with `google-services.json`; a phone that uninstalls the app is
forgotten the next time a push to it fails.

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

**Upgrading to plain-language entry (phase 4a):** the apps' tokens now need a second audience, `kitty-ai`, so the ai
service accepts them. A fresh server gets it from the realm file. On an existing one, once, in the admin console
(see below): Clients → `kitty-web` → Client scopes → `kitty-web-dedicated` → Add mapper → By configuration →
Audience, named `kitty-ai-audience`, Included Custom Audience `kitty-ai`, Add to access token on. Do the same for
`kitty-mobile`. Until then, typing a sentence answers "sign in again" (401), and everything else works.

## 5a. The Android app

Download the APK from the repository's GitHub Releases (`mobile-v*` tags) or from the latest `android` workflow run,
and open it on the phone (allow installs from that source when asked). Building it is described in
[apps/mobile/README.md](../../apps/mobile/README.md). Once you have the signing certificate's SHA-256, set
`ANDROID_CERT_SHA256` in `.env` and `up -d` again: invite and table links then open in the installed app.

## 5b. ChatGPT and Claude (MCP)

Kitty's MCP server lets people use Kitty from ChatGPT, Claude and other AI assistants. They add
`https://<KITTY_HOST>/ai/mcp` as a connector and sign in with their Kitty account. Assistants can read the person's
groups, balances and expenses, and prepare drafts the person saves in Kitty from a link. They never save anything
themselves.

1. Set `KITTY_MCP_CLIENT_SECRET` in `deploy/compose/.env` (`openssl rand -hex 24`), then `up -d` again.
2. A realm first imported **after** phase 4d already has everything below. A realm imported before it doesn't, because
   Keycloak imports `infra/keycloak/kitty-realm.json` only on the very first start. Make these changes in the admin
   console (see below), matching that file:
   - **Clients → Create client** `kitty-ledger`: OpenID Connect, client authentication on, and every flow off. It's
     only an audience name for the token exchange.
   - **Client scopes → Create** `kitty-mcp`: type Default, include in token scope, display on the consent screen.
     Add a mapper: By configuration → Audience, included custom audience `kitty-mcp`, add to access token.
   - **Clients → Create client** `kitty-mcp`:
     - client authentication on, every flow off
     - Credentials: the secret from step 1
     - Advanced → Standard token exchange: on
     - Client scopes → dedicated scope → mapper: Audience, custom audience `kitty-ledger`, access token
   - Make sure `kitty-web`, `kitty-mobile` and `kitty-pulse` do **not** have `kitty-mcp` among their client scopes.
     Their tokens must not work at `/ai/mcp`.
   - **Clients → Client registration → Anonymous access policies**:
     - Trusted Hosts: `localhost`, `127.0.0.1`, `chatgpt.com`, `claude.ai`, `claude.com`. Turn "host sending
       registration request must match" off and "client URIs must match" on.
     - Allowed Client Scopes: allow default scopes on.
     - Keep Consent Required, Full Scope Disabled and Max Clients.
3. Check from your own machine (both are also in `smoke.sh`):

```bash
curl -i https://<KITTY_HOST>/ai/mcp                    # 401, with a resource_metadata=... header
curl https://<KITTY_HOST>/.well-known/oauth-protected-resource/ai/mcp   # names https://<KITTY_HOST>/auth/realms/kitty
```

To try it, add the connector in Claude (Settings → Connectors → Add custom connector) or in ChatGPT (developer mode →
connectors) with the address above.

## Keycloak admin console

It is not reachable from the internet. From your own machine:

```bash
ssh -L 8180:127.0.0.1:8180 ubuntu@<server-ip>
# then open http://localhost:8180/auth/admin  (user: admin, password: KEYCLOAK_ADMIN_PASSWORD)
```

The realm is imported from `infra/keycloak/kitty-realm.json` only on the very first start.
Later realm changes are made in the admin console (or by re-importing deliberately).

## Backups

`deploy/compose/backup.sh` runs every night at 01:17 UTC (03:17 SAST) and writes one dated
`kitty-<UTC time>.tar.gz` to `~/kitty-backups` (a few hundred KB for a small group). Each holds:

| File | What |
|---|---|
| `globals.sql` | Postgres roles (`postgres`, `ai`, `pulse`) with their password hashes |
| `ledger.dump` | the ledger database, including the ai and pulse tables (`pg_dump -Fc`) |
| `keycloak.dump` | accounts and sign-in settings: losing this locks everyone out |
| `azurite.tar.gz` | receipt photos |

Redpanda's event log and Caddy's certificates are left out: both rebuild themselves.

The server keeps the newest 7; a copy of each goes to the private Object Storage bucket
`kitty-backups` (Always Free: 20 GB), where a lifecycle rule deletes copies after 30 days.

### Setting it up (once)

1. Object Storage, in the server's compartment:
   ```bash
   oci os bucket create --compartment-id <compartment> --name kitty-backups --public-access-type NoPublicAccess
   # The lifecycle rule needs Object Storage itself to be allowed to delete, for this bucket only:
   oci iam policy create --compartment-id <tenancy> --name kitty-backups-lifecycle \
     --description "Lets Object Storage delete Kitty backups older than 30 days" \
     --statements "[\"Allow service objectstorage-<region> to manage object-family in tenancy where target.bucket.name='kitty-backups'\"]"
   oci os object-lifecycle-policy put --bucket-name kitty-backups --force --items \
     '[{"name":"delete-after-30-days","action":"DELETE","timeAmount":30,"timeUnit":"DAYS","isEnabled":true,"objectNameFilter":{"inclusionPrefixes":["kitty-"]}}]'
   ```
2. A **write-only** upload link: the server can add backups but can't list, read or delete them, so a
   compromised server can't touch the copies. Save it on the server as `~/.kitty-backup-par` (mode 600):
   ```bash
   oci os preauth-request create --bucket-name kitty-backups --name kitty-server-upload \
     --access-type AnyObjectWrite --bucket-listing-action Deny --time-expires <date, e.g. 5 years out>
   ```
   The link in use expires on **2031-11-27**; make a new one before then. Without the file the script
   still backs up, to the server only, and says so in its log.
3. The schedule, `/etc/cron.d/kitty-backup`:
   ```
   SHELL=/bin/bash
   PATH=/usr/local/bin:/usr/bin:/bin
   17 1 * * * ubuntu /home/ubuntu/kitty/deploy/compose/backup.sh >> /home/ubuntu/kitty-backups/backup.log 2>&1
   ```

Check on it with `tail ~/kitty-backups/backup.log`: each night adds a `backup ok` line. Nothing alerts
on a failed night yet (Phase 5 monitoring will).

### Restoring

Into a fresh deployment (or after wiping the `kitty_pgdata` volume), from the newest backup:

```bash
cd ~/kitty
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env stop ledger web ai pulse keycloak
d=$(mktemp -d) && tar xzf ~/kitty-backups/kitty-<time>.tar.gz -C "$d"
docker exec -i kitty-postgres-1 psql -U postgres < "$d/globals.sql"        # "already exists" errors are fine
for db in ledger keycloak; do
  docker exec kitty-postgres-1 dropdb -U postgres --if-exists "$db"
  docker exec kitty-postgres-1 createdb -U postgres "$db"
  docker exec -i kitty-postgres-1 pg_restore -U postgres -d "$db" --exit-on-error < "$d/$db.dump"
done
docker exec -i kitty-azurite-1 tar xzf - -C /data < "$d/azurite.tar.gz"
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env up -d
rm -rf "$d"
```

Keep the same `.env`: the restored roles keep their passwords, and Keycloak's client secrets live in its
database. A copy from Object Storage: `oci os object get --bucket-name kitty-backups --name <name> --file <name>`.

To test a backup without touching the live data, restore it into a throwaway container
(`docker run -d --network none -e POSTGRES_PASSWORD=x -v "$d":/backup:ro pgvector/pgvector:pg17`) and
compare each table's row count with the live database. The first backup was checked this way on
2026-11-27: every table matched.
