#!/usr/bin/env bash
# Restores a Kitty backup (deploy/compose/backup.sh) into the k3s cluster, replacing its data:
#   Postgres roles, the ledger and keycloak databases, and the receipt photos.
# Stops the apps that write (scaled to 0) while it runs and starts them again afterwards; --no-start leaves them
# stopped (the switch compares the data first: deploy/k3s/compare-data.sh). Postgres keeps running. Azurite is
# stopped while its volume is refilled: it keeps its blob index in memory and would overwrite restored files.
# These workloads carry no replica count in git, so Argo CD doesn't undo the scaling.
#
# Usage (kubectl pointed at the cluster): deploy/k3s/restore.sh <kitty-…tar.gz> [--no-start]
set -euo pipefail

archive="${1:-}"
[ -n "$archive" ] && [ -r "$archive" ] || { echo "usage: restore.sh <kitty-…tar.gz> [--no-start]" >&2; exit 2; }
start=true
case "${2:-}" in
  "") ;;
  --no-start) start=false ;;
  *) echo "usage: restore.sh <kitty-…tar.gz> [--no-start]" >&2; exit 2 ;;
esac

NS=kitty
APPS=(kitty-ledger kitty-web kitty-ai kitty-pulse keycloak)
START_APPS="kubectl -n $NS scale deployment ${APPS[*]} --replicas=1"
k() { kubectl -n "$NS" "$@"; }
pod() { k get pod -o jsonpath='{.items[0].metadata.name}' -l "app.kubernetes.io/name=$1"; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
trap 'echo "restore FAILED. Once fixed: kubectl -n $NS scale statefulset azurite --replicas=1; $START_APPS" >&2' ERR
tar xzf "$archive" -C "$work"
for f in globals.sql ledger.dump keycloak.dump azurite.tar.gz; do
  [ -s "$work/$f" ] || { echo "$archive has no $f" >&2; exit 2; }
done

pg=$(pod postgres)
[ -n "$pg" ] || { echo "postgres pod not found in namespace $NS" >&2; exit 1; }

echo "stopping ${APPS[*]}"
k scale deployment "${APPS[@]}" --replicas=0
k wait --for=delete pod --timeout=180s -l "app.kubernetes.io/name in ($(IFS=,; echo "${APPS[*]}"))" || true

echo "restoring roles"
# "already exists" for roles the cluster created itself is expected, so errors here don't stop the restore.
k exec -i "$pg" -- psql -U postgres -q < "$work/globals.sql" || true
for db in ledger keycloak; do
  echo "restoring $db"
  k exec "$pg" -- dropdb -U postgres --if-exists --force "$db"
  k exec "$pg" -- createdb -U postgres "$db"
  k exec -i "$pg" -- pg_restore -U postgres -d "$db" --exit-on-error < "$work/$db.dump"
done

echo "restoring receipt photos"
k scale statefulset azurite --replicas=0
k wait --for=delete pod/azurite-0 --timeout=120s || true
# A throwaway pod mounts Azurite's volume, empties it and unpacks the backup into it.
container='{"name":"restore-photos","image":"busybox:1.37","stdin":true,"stdinOnce":true,'
container+='"command":["sh","-c","find /data -mindepth 1 -delete && tar xzf - -C /data"],'
container+='"volumeMounts":[{"name":"data","mountPath":"/data"}]}'
overrides='{"spec":{"containers":['"$container"'],"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"data-azurite-0"}}]}}'
k run restore-photos --rm -i --quiet --restart=Never --image=busybox:1.37 --overrides="$overrides" \
  < "$work/azurite.tar.gz"
k scale statefulset azurite --replicas=1
k rollout status statefulset azurite --timeout=5m

if $start; then
  echo "starting ${APPS[*]}"
  k scale deployment "${APPS[@]}" --replicas=1
  for app in "${APPS[@]}"; do
    k rollout status deployment "$app" --timeout=10m
  done
  echo "restored $(basename "$archive")"
else
  echo "restored $(basename "$archive"); the apps are still stopped. Start them with: $START_APPS"
fi
