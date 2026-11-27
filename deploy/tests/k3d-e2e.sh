#!/usr/bin/env bash
# Installs all of Kitty into a throwaway k3d cluster, as production would run it (production values plus
# deploy/tests/ci-values.yaml: host kitty.localhost, a self-signed certificate, notifications off), then:
#   1. the 16 smoke checks (deploy/compose/smoke.sh --insecure),
#   2. a receipt photo over 11 MB is refused at the edge (413),
#   3. a WebSocket upgrade for live table updates reaches the ledger,
#   4. every pod deleted at once, and Kitty comes back on its own: the smoke checks again.
# Needs docker, k3d, helm and kubectl. Run from anywhere: deploy/tests/k3d-e2e.sh   (CI: .github/workflows/deploy.yml)
set -euo pipefail
cd "$(dirname "$0")/../.."

K3S_IMAGE="${K3S_IMAGE:-rancher/k3s:v1.37.2-k3s1}"
CERT_MANAGER_VERSION="${CERT_MANAGER_VERSION:-v1.21.3}"
HOST=kitty.localhost
CHARTS=(postgres redis redpanda azurite keycloak kitty-pulse kitty-ledger kitty-ai kitty-web kitty-edge)

echo "::group::cluster"
k3d cluster create kitty-ci --image "$K3S_IMAGE" -p "80:80@loadbalancer" -p "443:443@loadbalancer" --wait
helm repo add jetstack https://charts.jetstack.io --force-update >/dev/null
helm upgrade --install cert-manager jetstack/cert-manager --version "$CERT_MANAGER_VERSION" \
  -n cert-manager --create-namespace --set crds.enabled=true --wait --timeout 5m
echo "::endgroup::"

echo "::group::settings (dummy values, never sealed)"
kubectl create namespace kitty
env_file=$(mktemp)
for k in POSTGRES_PASSWORD KEYCLOAK_ADMIN_PASSWORD AUTH_SECRET KITTY_WEB_CLIENT_SECRET AI_DB_PASSWORD \
  PULSE_DB_PASSWORD PULSE_CLIENT_SECRET KITTY_MCP_CLIENT_SECRET SMTP_PASSWORD; do
  echo "$k=$(openssl rand -hex 16)" >> "$env_file"
done
{ echo "BLOB_ACCOUNT_KEY=$(openssl rand -base64 32)"; echo "GEMINI_API_KEY=ci-dummy"
  echo "SMTP_USER=ci@kitty.localhost"; echo "SMTP_FROM=ci@kitty.localhost"; } >> "$env_file"
deploy/k3s/seal-env.sh "$env_file" --plain | kubectl apply -f -
rm -f "$env_file"
echo "::endgroup::"

echo "::group::kitty"
for chart in "${CHARTS[@]}"; do
  helm upgrade --install "$chart" "deploy/charts/$chart" -n kitty \
    -f "deploy/values/production/$chart.yaml" -f deploy/tests/ci-values.yaml
done
kubectl -n kitty rollout status statefulset --timeout=10m
kubectl -n kitty wait --for=condition=Available deployment --all --timeout=15m
kubectl -n kitty wait --for=condition=Ready certificate/kitty-tls --timeout=5m
kubectl -n kitty get pods -o wide
echo "::endgroup::"

curl_k=(curl -s -m 30 -k --resolve "$HOST:443:127.0.0.1")
failures=0
expect() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (expected $2, got $3)"; failures=$((failures + 1)); fi
}

echo "== smoke"
deploy/compose/smoke.sh "$HOST" --insecure || failures=$((failures + 1))

echo "== receipt photo size limit"
big=$(mktemp) && head -c $((12 * 1024 * 1024)) /dev/zero > "$big"
expect "a 12 MB photo is refused" 413 \
  "$("${curl_k[@]}" -o /dev/null -w '%{http_code}' -X PUT -H 'x-ms-blob-type: BlockBlob' --data-binary "@$big" \
    "https://$HOST/blob/kitty/receipts/big")"
rm -f "$big"

echo "== live table updates (WebSocket)"
ws=$("${curl_k[@]}" -i --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "https://$HOST/api/hubs/table" || true)
status=$(printf '%s' "$ws" | head -n 1 | awk '{print $2}')
case "$status" in
  101 | 400 | 401) expect "the upgrade reaches the ledger (status $status)" yes yes ;;
  *) expect "the upgrade reaches the ledger" "101, 400 or 401" "$status" ;;
esac
expect "not Traefik's own 404" 0 "$(printf '%s' "$ws" | grep -c '404 page not found' || true)"

echo "== everything restarts at once"
kubectl -n kitty delete pods --all --wait=false
sleep 10
kubectl -n kitty rollout status statefulset --timeout=10m
kubectl -n kitty wait --for=condition=Available deployment --all --timeout=15m
deploy/compose/smoke.sh "$HOST" --insecure || failures=$((failures + 1))

[ "$failures" -eq 0 ] && echo "k3d end-to-end: all passed" || { echo "k3d end-to-end: $failures failed"; exit 1; }
