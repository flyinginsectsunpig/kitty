#!/usr/bin/env bash
# Creates the accounts listed in dev-test-users.md in the local (ephemeral) Keycloak, already email-verified.
# Usage: infra/keycloak/seed-dev-users.sh  [keycloak base url, default http://localhost:8180]
# Needs the Aspire-generated admin password: reads it from the app host's user secrets.
set -euo pipefail

KC="${1:-http://localhost:8180}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ADMIN_PASSWORD="$(dotnet user-secrets list --project "$HERE/../../aspire/Kitty.AppHost" | sed -n 's/^Parameters:keycloak-password = //p')"
[ -n "$ADMIN_PASSWORD" ] || { echo "No keycloak-password in the app host's user secrets; run the app host once first." >&2; exit 1; }

TOKEN="$(curl -fsS "$KC/realms/master/protocol/openid-connect/token" \
  --data-urlencode grant_type=password --data-urlencode client_id=admin-cli \
  --data-urlencode username=admin --data-urlencode "password=$ADMIN_PASSWORD" | python -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')"

grep -E '^\| [^ ]+@kitty\.test \|' "$HERE/dev-test-users.md" | while IFS='|' read -r _ email password _; do
  email="$(echo "$email" | xargs)"; password="$(echo "$password" | xargs)"
  first="$(echo "${email%%@*}" | sed 's/.*/\u&/')"
  body="$(python -c 'import json,sys;print(json.dumps({"username":sys.argv[1],"email":sys.argv[1],"firstName":sys.argv[3],"lastName":"Test","enabled":True,"emailVerified":True,"credentials":[{"type":"password","value":sys.argv[2],"temporary":False}]}))' "$email" "$password" "$first")"
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$KC/admin/realms/kitty/users" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body")"
  echo "$email: $code (201 created, 409 already exists)"
done
