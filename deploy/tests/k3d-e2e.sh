#!/usr/bin/env bash
# Installs all of Kitty into a throwaway k3d cluster, as production would run it (production values plus
# deploy/tests/ci-values.yaml: host kitty.localhost, a self-signed certificate, notifications off), then:
#   1. the 16 smoke checks (deploy/compose/smoke.sh --insecure),
#   2. a receipt photo over 11 MB is refused at the edge (413),
#   3. a WebSocket upgrade for live table updates reaches the ledger,
#   4. every pod deleted at once, and Kitty comes back on its own: the smoke checks again,
#   5. telemetry reaches the OpenTelemetry collector with Kubernetes attributes and nothing scrubbed left in it,
#   6. with Grafana Cloud unreachable, Kitty answers as fast as before,
#   7. with the collector gone, Kitty keeps working.
# Needs docker, k3d, helm and kubectl. Run from anywhere: deploy/tests/k3d-e2e.sh   (CI: .github/workflows/deploy.yml)
set -euo pipefail
cd "$(dirname "$0")/../.."

K3S_IMAGE="${K3S_IMAGE:-rancher/k3s:v1.37.2-k3s1}"
CERT_MANAGER_VERSION="${CERT_MANAGER_VERSION:-v1.21.3}"
OTEL_COLLECTOR_CHART="${OTEL_COLLECTOR_CHART:-0.183.2}"
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

echo "::group::otel collector (exports to its own log: deploy/tests/ci-values-otel.yaml)"
kubectl create namespace observability
grafana_env=$(mktemp)
printf 'GRAFANA_OTLP_ENDPOINT=http://unused.invalid\nGRAFANA_OTLP_INSTANCE_ID=0\nGRAFANA_OTLP_TOKEN=ci-dummy\n' > "$grafana_env"
deploy/k3s/seal-env.sh "$grafana_env" --grafana --plain | kubectl apply -f -
rm -f "$grafana_env"
collector() { # extra helm args
  helm upgrade --install otel-collector opentelemetry-collector \
    --repo https://open-telemetry.github.io/opentelemetry-helm-charts --version "$OTEL_COLLECTOR_CHART" \
    -n observability -f deploy/values/production/otel-collector.yaml "$@" --wait --timeout 5m
}
collector -f deploy/tests/ci-values-otel.yaml
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
# A real photo (2-10 MB) is buffered to disk by Traefik above 1 MB: one just under the limit must still reach Azurite,
# whose own signature check answers with an XML <Code> (the upload isn't signed).
near=$(mktemp) && head -c $((10 * 1024 * 1024)) /dev/zero > "$near"
expect "a 10 MB photo reaches blob storage" 1 \
  "$("${curl_k[@]}" -X PUT -H 'x-ms-blob-type: BlockBlob' --data-binary "@$near" \
    "https://$HOST/blob/kitty/receipts/near" | grep -c '<Code>' || true)"
rm -f "$near"

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

echo "== telemetry reaches the collector, scrubbed"
sleep 20 # the services and the collector export in batches
otel_logs=$(kubectl -n observability logs ds/otel-collector-agent --since=60m 2>/dev/null || true)
# Not printf | grep -q: grep quits at the first match, printf gets SIGPIPE, and pipefail turns "found" into "no".
has() { grep -qF "$1" <<<"$otel_logs" && echo yes || echo no; }
expect "a ledger span reached the collector" yes "$(has 'service.name: Str(ledger)')"
expect "with Kubernetes attributes" yes "$(has 'k8s.namespace.name: Str(kitty)')"
expect "no client address, full URL or bearer token in what would leave" 0 \
  "$(printf '%s' "$otel_logs" | grep -cE 'client\.address|url\.full|Bearer [A-Za-z0-9]' || true)"

median_ms() { # n requests to an endpoint that is traced, the median time in ms
  for _ in $(seq 20); do "${curl_k[@]}" -o /dev/null -w '%{time_total}\n' "https://$HOST/api/me"; done \
    | sort -n | awk '{a[NR]=$1} END {printf "%d", a[int((NR+1)/2)] * 1000}'
}

echo "== Grafana unreachable: Kitty answers as fast"
before=$(median_ms)
collector -f deploy/tests/ci-values-otel-blackhole.yaml
sleep 30
after=$(median_ms)
expect "median /api/me ${before}ms before, ${after}ms after" yes "$([ "$after" -le $((before * 2 + 50)) ] && echo yes || echo no)"
deploy/compose/smoke.sh "$HOST" --insecure || failures=$((failures + 1))

echo "== the collector gone: Kitty keeps working"
kubectl -n observability patch daemonset otel-collector-agent --type merge \
  -p '{"spec":{"template":{"spec":{"nodeSelector":{"kitty-ci/no-such-node":"true"}}}}}'
kubectl -n observability wait --for=delete pod -l app.kubernetes.io/name=opentelemetry-collector --timeout=120s || true
deploy/compose/smoke.sh "$HOST" --insecure || failures=$((failures + 1))

[ "$failures" -eq 0 ] && echo "k3d end-to-end: all passed" || { echo "k3d end-to-end: $failures failed"; exit 1; }
