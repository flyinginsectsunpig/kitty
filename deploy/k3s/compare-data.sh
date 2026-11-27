#!/usr/bin/env bash
# Proves the cluster holds the same data as Compose: for the ledger and keycloak databases, every table's row count and
# a checksum of all its rows, from both Postgres servers, side by side. Exit 0 only if every table matches.
# Run on the server while both are up (the rehearsal and the switch, deploy/k3s/RUNBOOK.md):
#   deploy/k3s/compare-data.sh
set -euo pipefail

PROJECT="${KITTY_COMPOSE_PROJECT:-kitty}"
NS=kitty

# One line per table: "<schema.table> <rows> <md5 of the rows, ordered by their text>". The first query writes one
# SELECT per table; the second psql runs them.
LIST="SELECT format('SELECT %L, count(*), md5(coalesce(string_agg(t::text, E''\\n'' ORDER BY t::text), '''')) FROM %I.%I t;',
  n.nspname || '.' || c.relname, n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY 1"

compose_psql() { docker exec -i "$PROJECT-postgres-1" psql -U postgres -At -F ' ' "$@"; }
pg_pod=$(kubectl -n "$NS" get pod -o jsonpath='{.items[0].metadata.name}' -l app.kubernetes.io/name=postgres)
cluster_psql() { kubectl -n "$NS" exec -i "$pg_pod" -- psql -U postgres -At -F ' ' "$@"; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
status=0
for db in ledger keycloak; do
  compose_psql -d "$db" -c "$LIST" | compose_psql -d "$db" > "$work/compose-$db"
  cluster_psql -d "$db" -c "$LIST" | cluster_psql -d "$db" > "$work/cluster-$db"
  if diff "$work/compose-$db" "$work/cluster-$db" > "$work/diff-$db"; then
    echo "$db: $(wc -l < "$work/compose-$db") tables, all identical"
  else
    echo "$db: differences (< compose, > cluster):"
    cat "$work/diff-$db"
    status=1
  fi
done
exit $status
