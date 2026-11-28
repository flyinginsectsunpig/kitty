#!/usr/bin/env bash
# Turns the secret settings in a Compose .env file into a SealedSecret for the cluster (Secret "kitty-secrets",
# namespace "kitty"), written to stdout. Only the cluster's Sealed Secrets controller can open the result, so it is
# safe to commit (deploy/secrets/production/kitty-secrets.yaml).
#
# Run by the owner ON THE SERVER, because .env holds the Gemini key and the Gmail app password:
#   deploy/k3s/seal-env.sh ~/kitty/deploy/compose/.env > kitty-secrets.yaml
# --grafana seals the Grafana Cloud OTLP settings instead (Secret "grafana-cloud", namespace "observability"):
#   deploy/k3s/seal-env.sh ~/kitty/deploy/compose/.env --grafana > grafana-cloud.yaml
# --plain skips kubeseal and prints the unsealed Secret (CI's throwaway cluster and the tests use it).
# Values are never printed, only key names.
set -euo pipefail

USAGE="usage: seal-env.sh <env-file> [--grafana] [--plain]"
file="${1:?$USAGE}"
shift
plain=false
grafana=false
for arg in "$@"; do
  case "$arg" in
    --plain) plain=true ;;
    --grafana) grafana=true ;;
    *) echo "$USAGE" >&2; exit 2 ;;
  esac
done
[ -r "$file" ] || { echo "can't read $file" >&2; exit 2; }

if $grafana; then
  NAME=grafana-cloud NAMESPACE=observability
  REQUIRED=(GRAFANA_OTLP_ENDPOINT GRAFANA_OTLP_INSTANCE_ID GRAFANA_OTLP_TOKEN)
  OPTIONAL=()
else
  NAME=kitty-secrets NAMESPACE=kitty
  REQUIRED=(POSTGRES_PASSWORD KEYCLOAK_ADMIN_PASSWORD AUTH_SECRET KITTY_WEB_CLIENT_SECRET BLOB_ACCOUNT_KEY
    AI_DB_PASSWORD PULSE_DB_PASSWORD PULSE_CLIENT_SECRET KITTY_MCP_CLIENT_SECRET GEMINI_API_KEY
    SMTP_USER SMTP_FROM SMTP_PASSWORD)
  OPTIONAL=(GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET) # default "unset", as in docker-compose.yml
fi

# The value of KEY in the file: everything after the first '=' on its last KEY= line, without a trailing \r.
value_of() {
  grep -E "^$1=" "$file" | tail -n 1 | cut -d= -f2- | tr -d '\r' || true
}

missing=()
for key in "${REQUIRED[@]}"; do
  [ -n "$(value_of "$key")" ] || missing+=("$key")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "missing or empty in $file: ${missing[*]}" >&2
  exit 2
fi

secret() {
  printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: %s\n  namespace: %s\ntype: Opaque\ndata:\n' "$NAME" "$NAMESPACE"
  for key in "${REQUIRED[@]}" ${OPTIONAL[@]+"${OPTIONAL[@]}"}; do
    v=$(value_of "$key")
    [ -n "$v" ] || v=unset
    printf '  %s: %s\n' "$key" "$(printf '%s' "$v" | base64 | tr -d '\n')"
  done
}

if $plain; then
  secret
else
  secret | kubeseal --format yaml
fi
