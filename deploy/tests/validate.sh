#!/usr/bin/env bash
# Lints every chart and validates its rendered output (production values) against Kubernetes and CRD schemas.
# Usage (repo root): deploy/tests/validate.sh      Needs helm and kubeconform on PATH.
set -euo pipefail
cd "$(dirname "$0")/../.."

# CRD schemas (Traefik, cert-manager, Argo CD, Sealed Secrets) come from the datree catalog. k3s's own HelmChartConfig
# isn't in it, so it is skipped by name.
CRDS='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
status=0
for dir in deploy/charts/*/; do
  chart=$(basename "$dir")
  values="deploy/values/production/$chart.yaml"
  echo "== $chart"
  helm lint --quiet "$dir" -f "$values" || status=1
  helm template "$chart" "$dir" -f "$values" --namespace kitty \
    | kubeconform -strict -summary -skip HelmChartConfig \
        -schema-location default -schema-location "$CRDS" || status=1
done
exit $status
