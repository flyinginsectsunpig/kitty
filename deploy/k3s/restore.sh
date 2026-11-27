#!/usr/bin/env bash
# Restores a Kitty backup (deploy/compose/backup.sh) into the k3s cluster, replacing its data:
#   Postgres roles, the ledger and keycloak databases, and the receipt photos.
# Stops the apps that write (scaled to 0) while it runs and starts them again afterwards. Postgres and Azurite keep
# running. Their Deployments carry no replica count in git, so Argo CD doesn't undo the scaling.
#
# Usage (kubectl pointed at the cluster): deploy/k3s/restore.sh <kitty-…tar.gz>
set -euo pipefail

archive="${1:-}"
[ -n "$archive" ] && [ -r "$archive" ] || { echo "usage: restore.sh <kitty-…tar.gz> (a readable backup archive)" >&2; exit 2; }

NS=kitty
APPS=(kitty-ledger kitty-web kitty-ai kitty-pulse keycloak)
k() { kubectl -n "$NS" "$@"; }
pod() { k get pod -o jsonpath='{.items[0].metadata.name}' -l "app.kubernetes.io/name=$1"; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar xzf "$archive" -C "$work"
for f in globals.sql ledger.dump keycloak.dump azurite.tar.gz; do
  [ -s "$work/$f" ] || { echo "$archive has no $f" >&2; exit 2; }
done

pg=$(pod postgres)
az=$(pod azurite)
[ -n "$pg" ] && [ -n "$az" ] || { echo "postgres or azurite pod not found in namespace $NS" >&2; exit 1; }

echo "stopping ${APPS[*]}"
k scale deployment "${APPS[@]}" --replicas=0
k wait --for=delete pod --timeout=180s -l "app.kubernetes.io/name in ($(IFS=,; echo "${APPS[*]}"))" || true

echo "restoring roles"
# "already exists" for roles the cluster created itself is expected.
k exec -i "$pg" -- psql -U postgres -q < "$work/globals.sql" || true
for db in ledger keycloak; do
  echo "restoring $db"
  k exec "$pg" -- dropdb -U postgres --if-exists "$db"
  k exec "$pg" -- createdb -U postgres "$db"
  k exec -i "$pg" -- pg_restore -U postgres -d "$db" --exit-on-error < "$work/$db.dump"
done
echo "restoring receipt photos"
k exec -i "$az" -- tar xzf - -C /data < "$work/azurite.tar.gz"

echo "starting ${APPS[*]}"
k scale deployment "${APPS[@]}" --replicas=1
for app in "${APPS[@]}"; do
  k rollout status deployment "$app" --timeout=10m
done
echo "restored $(basename "$archive")"
