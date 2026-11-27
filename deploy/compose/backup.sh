#!/usr/bin/env bash
# Nightly backup of a Kitty Compose deployment: one dated .tar.gz holding
#   globals.sql      Postgres roles (pg_dumpall --globals-only)
#   ledger.dump      the ledger database, with the ai and pulse tables (pg_dump -Fc)
#   keycloak.dump    accounts and sign-in settings (pg_dump -Fc)
#   azurite.tar.gz   receipt photos
# Redpanda's event log and Caddy's certificates are left out: both rebuild themselves.
#
# Keeps the newest $KITTY_BACKUP_KEEP (default 7) on the server and, when $KITTY_BACKUP_PAR_FILE
# (default ~/.kitty-backup-par) holds an Object Storage write-only pre-authenticated URL, uploads a copy.
# Restore steps: RUNBOOK.md, "Backups".
#
# Usage: deploy/compose/backup.sh   (run by /etc/cron.d/kitty-backup)
set -euo pipefail

PROJECT="${KITTY_COMPOSE_PROJECT:-kitty}"
OUT_DIR="${KITTY_BACKUP_DIR:-$HOME/kitty-backups}"
KEEP="${KITTY_BACKUP_KEEP:-7}"
PAR_FILE="${KITTY_BACKUP_PAR_FILE:-$HOME/.kitty-backup-par}"

[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || { echo "KITTY_BACKUP_KEEP must be a positive number" >&2; exit 2; }
for c in postgres azurite; do
  docker inspect -f '{{.State.Running}}' "$PROJECT-$c-1" 2>/dev/null | grep -qx true \
    || { echo "container $PROJECT-$c-1 is not running" >&2; exit 1; }
done

umask 077
mkdir -p "$OUT_DIR"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

docker exec "$PROJECT-postgres-1" pg_dumpall -U postgres --globals-only > "$work/globals.sql"
for db in ledger keycloak; do
  docker exec "$PROJECT-postgres-1" pg_dump -U postgres -Fc "$db" > "$work/$db.dump"
done
docker exec "$PROJECT-azurite-1" tar czf - -C /data . > "$work/azurite.tar.gz"

name="kitty-$(date -u +%Y-%m-%dT%H%MZ).tar.gz"
tar czf "$OUT_DIR/$name.part" -C "$work" .
mv "$OUT_DIR/$name.part" "$OUT_DIR/$name"

# Keep the newest $KEEP; names sort by date.
ls -1 "$OUT_DIR"/kitty-*.tar.gz | sort | head -n -"$KEEP" | xargs -r rm --

if [ -s "$PAR_FILE" ]; then
  par=$(tr -d '[:space:]' < "$PAR_FILE") # a stray newline or \r would break the URL
  curl -fsS --retry 3 -T "$OUT_DIR/$name" "$par$name"
  where="server and Object Storage"
else
  where="server only (no $PAR_FILE)"
fi
echo "$(date -u +%FT%TZ) backup ok: $name, $(du -h "$OUT_DIR/$name" | cut -f1), kept on $where"
