#!/usr/bin/env bash
# Installs Argo CD and points it at Kitty's git repository; Argo CD installs everything else (cert-manager, Sealed
# Secrets, Kitty's charts) from deploy/apps. Safe to run again: it upgrades Argo CD and re-points the revision.
# Usage (repo root, kubectl pointed at the cluster): deploy/k3s/bootstrap.sh <git revision>   e.g. main
set -euo pipefail
cd "$(dirname "$0")/../.."

rev="${1:?usage: bootstrap.sh <git revision, e.g. main>}"
[[ "$rev" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "not a git revision: $rev" >&2; exit 2; }

helm repo add argo https://argoproj.github.io/argo-helm --force-update >/dev/null
helm upgrade --install argocd argo/argo-cd --version 10.20.0 \
  --namespace argocd --create-namespace \
  -f deploy/platform/argocd-values.yaml --wait --timeout 10m

sed "s|REVISION|$rev|g" deploy/k3s/root-app.yaml | kubectl apply -f -
echo "Argo CD follows $rev. Watch it with: kubectl -n argocd get applications"
