#!/usr/bin/env bash
# Nightly backup of Kitty, from Compose or from the k3s cluster: one dated .tar.gz holding
#   globals.sql      Postgres roles (pg_dumpall --globals-only)
#   ledger.dump      the ledger database, with the ai and pulse tables (pg_dump -Fc)
#   keycloak.dump    accounts and sign-in settings (pg_dump -Fc)
#   azurite.tar.gz   receipt photos
# Redpanda's event log and Caddy's certificates are left out: both rebuild themselves.
#
# Keeps the newest $KITTY_BACKUP_KEEP (default 7) on the server and, when $KITTY_BACKUP_PAR_FILE
# (default ~/.kitty-backup-par) holds an Object Storage write-only pre-authenticated URL, uploads a copy.
# Restore steps: deploy/k3s/RUNBOOK.md ("Backups"; deploy/k3s/restore.sh) or, for Compose, RUNBOOK.md.
#
# KITTY_BACKUP_TARGET=compose (default) reads the Compose containers; k3s reads the pods in namespace "kitty".
# Usage: deploy/compose/backup.sh   (run by /etc/cron.d/kitty-backup)
set -euo pipefail

TARGET="${KITTY_BACKUP_TARGET:-compose}"
PROJECT="${KITTY_COMPOSE_PROJECT:-kitty}"
OUT_DIR="${KITTY_BACKUP_DIR:-$HOME/kitty-backups}"
KEEP="${KITTY_BACKUP_KEEP:-7}"
PAR_FILE="${KITTY_BACKUP_PAR_FILE:-$HOME/.kitty-backup-par}"

[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || { echo "KITTY_BACKUP_KEEP must be a positive number" >&2; exit 2; }
case "$TARGET" in
  compose)
    for c in postgres azurite; do
      docker inspect -f '{{.State.Running}}' "$PROJECT-$c-1" 2>/dev/null | grep -qx true \
        || { echo "container $PROJECT-$c-1 is not running" >&2; exit 1; }
    done
    in_postgres() { docker exec "$PROJECT-postgres-1" "$@"; }
    in_azurite() { docker exec "$PROJECT-azurite-1" "$@"; }
    ;;
  k3s)
    pod() { kubectl -n kitty get pod -o jsonpath='{.items[0].metadata.name}' -l "app.kubernetes.io/name=$1"; }
    pg_pod=$(pod postgres) && az_pod=$(pod azurite) && [ -n "$pg_pod" ] && [ -n "$az_pod" ] \
      || { echo "postgres or azurite pod not found in namespace kitty" >&2; exit 1; }
    in_postgres() { kubectl -n kitty exec "$pg_pod" -- "$@"; }
    in_azurite() { kubectl -n kitty exec "$az_pod" -- "$@"; }
    ;;
  *) echo "KITTY_BACKUP_TARGET must be compose or k3s, not $TARGET" >&2; exit 2 ;;
esac

umask 077
mkdir -p "$OUT_DIR"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

in_postgres pg_dumpall -U postgres --globals-only > "$work/globals.sql"
for db in ledger keycloak; do
  in_postgres pg_dump -U postgres -Fc "$db" > "$work/$db.dump"
done
in_azurite tar czf - -C /data . > "$work/azurite.tar.gz"

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

# k3s: tell the OpenTelemetry collector the backup succeeded (gauges kitty.backup.last_success, in Unix seconds,
# and kitty.backup.size_bytes), for the "no backup for 26 hours" alert. Reporting never fails the backup itself.
report_backup() { # <bytes>
  local ip now body
  ip=$(kubectl -n observability get svc otel-collector -o jsonpath='{.spec.clusterIP}' 2>/dev/null) || ip=""
  if [ -z "$ip" ]; then
    echo "backup ok, but reporting it failed: no otel-collector service"
    return 0
  fi
  now=$(date -u +%s)
  body='{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"kitty-backup"}}]},'
  body+='"scopeMetrics":[{"scope":{"name":"kitty-backup"},"metrics":['
  body+='{"name":"kitty.backup.last_success","unit":"s","gauge":{"dataPoints":[{"asInt":"'"$now"'","timeUnixNano":"'"$now"'000000000"}]}},'
  body+='{"name":"kitty.backup.size_bytes","unit":"By","gauge":{"dataPoints":[{"asInt":"'"$1"'","timeUnixNano":"'"$now"'000000000"}]}}'
  body+=']}]}]}'
  if ! curl -fsS -m 10 -X POST -H 'Content-Type: application/json' -d "$body" "http://$ip:4318/v1/metrics" >/dev/null; then
    echo "backup ok, but reporting it failed: the collector at $ip didn't take it"
  fi
}
if [ "$TARGET" = k3s ]; then
  report_backup "$(wc -c < "$OUT_DIR/$name" | tr -d ' ')"
fi
