#!/usr/bin/env bash
# Checks a running Kitty deployment from the outside.
# Usage: deploy/compose/smoke.sh <host> [--insecure | --connect-to <addr>:<port>]
#   --insecure    accept a local or self-signed CA and connect to 127.0.0.1 (a local trial, or CI's k3d cluster)
#   --connect-to  send every request to <addr>:<port> while keeping the URLs, Host and certificate name unchanged
#                 (the k3s cluster before the switch: deploy/compose/smoke.sh <host> --connect-to 127.0.0.1:30443)
set -uo pipefail

USAGE="usage: smoke.sh <host> [--insecure | --connect-to <addr>:<port>]"
HOST="${1:?$USAGE}"
CURL=(curl -s -m 15)
case "${2:-}" in
  "") ;;
  --insecure) CURL+=(-k --resolve "$HOST:443:127.0.0.1") ;;
  --connect-to) CURL+=(--connect-to "$HOST:443:${3:?$USAGE}") ;;
  *) echo "$USAGE" >&2; exit 2 ;;
esac
BASE="https://$HOST"
failures=0

check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (expected $2, got $3)"; failures=$((failures + 1)); fi
}

status() { "${CURL[@]}" -o /dev/null -w '%{http_code}' "$1"; }

check "web home page" 200 "$(status "$BASE/")"
# Auth.js lives under /api/auth on the web app, inside the /api prefix that otherwise goes to the ledger.
check "sign-in endpoints reach the web app" 1 "$("${CURL[@]}" "$BASE/api/auth/csrf" | grep -c '"csrfToken"')"
check "ledger health" 200 "$(status "$BASE/api/health")"
check "ledger rejects anonymous calls" 401 "$(status "$BASE/api/me")"
check "live table updates are reachable" 200 "$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/hubs/table/negotiate?negotiateVersion=1")"
# An unsigned upload must reach blob storage and be refused by it (an XML error), not by the web app.
check "receipt uploads reach blob storage" 1 "$("${CURL[@]}" -X PUT -H 'x-ms-blob-type: BlockBlob' --data-binary x "$BASE/blob/kitty/receipts/smoke" | grep -c '<Code>')"
check "receipt photos can't be read back" 404 "$(status "$BASE/blob/kitty/receipts/smoke")"
check "keycloak admin is not public" 404 "$(status "$BASE/auth/admin/")"
check "keycloak master realm is not public" 404 "$(status "$BASE/auth/realms/master/account")"
check "path-parameter bypass is blocked" 404 "$(status "$BASE/auth/realms/kitty/..;/master/account")"
check "encoded traversal is blocked" 404 "$(status "$BASE/auth/realms/kitty/%2e%2e/master/account")"
check "kitty sign-in page loads" 200 "$(status "$BASE/auth/realms/kitty/account")"

# MCP (ChatGPT, Claude): /ai/mcp asks for a token and points at its metadata, which names the realm.
check "mcp asks for a token" 401 "$(status "$BASE/ai/mcp")"
check "mcp points at its metadata" 1 "$("${CURL[@]}" -D - -o /dev/null "$BASE/ai/mcp"   | grep -ci "resource_metadata=\"$BASE/.well-known/oauth-protected-resource/ai/mcp\"")"
check "mcp metadata names the realm" 1 "$("${CURL[@]}" "$BASE/.well-known/oauth-protected-resource/ai/mcp"   | grep -c "\"$BASE/auth/realms/kitty\"")"

issuer="$("${CURL[@]}" "$BASE/auth/realms/kitty/.well-known/openid-configuration" \
  | sed -n 's/.*"issuer":"\([^"]*\)".*/\1/p')"
check "keycloak issuer" "$BASE/auth/realms/kitty" "$issuer"

[ "$failures" -eq 0 ] && echo "All checks passed." || { echo "$failures check(s) failed."; exit 1; }
