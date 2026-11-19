#!/usr/bin/env bash
# Checks a running Kitty deployment from the outside.
# Usage: deploy/compose/smoke.sh <host> [--insecure]
#   --insecure  accept Caddy's local CA (only for a local trial with a *.localhost name)
set -uo pipefail

HOST="${1:?usage: smoke.sh <host> [--insecure]}"
CURL=(curl -s -m 15)
[ "${2:-}" = "--insecure" ] && CURL+=(-k --resolve "$HOST:443:127.0.0.1")
BASE="https://$HOST"
failures=0

check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (expected $2, got $3)"; failures=$((failures + 1)); fi
}

status() { "${CURL[@]}" -o /dev/null -w '%{http_code}' "$1"; }

check "web home page" 200 "$(status "$BASE/")"
check "ledger health" 200 "$(status "$BASE/api/health")"
check "ledger rejects anonymous calls" 401 "$(status "$BASE/api/me")"
check "live table updates are reachable" 200 "$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/hubs/table/negotiate?negotiateVersion=1")"
check "keycloak admin is not public" 404 "$(status "$BASE/auth/admin/")"
check "keycloak master realm is not public" 404 "$(status "$BASE/auth/realms/master/account")"
check "path-parameter bypass is blocked" 404 "$(status "$BASE/auth/realms/kitty/..;/master/account")"
check "encoded traversal is blocked" 404 "$(status "$BASE/auth/realms/kitty/%2e%2e/master/account")"
check "kitty sign-in page loads" 200 "$(status "$BASE/auth/realms/kitty/account")"

issuer="$("${CURL[@]}" "$BASE/auth/realms/kitty/.well-known/openid-configuration" \
  | sed -n 's/.*"issuer":"\([^"]*\)".*/\1/p')"
check "keycloak issuer" "$BASE/auth/realms/kitty" "$issuer"

[ "$failures" -eq 0 ] && echo "All checks passed." || { echo "$failures check(s) failed."; exit 1; }
