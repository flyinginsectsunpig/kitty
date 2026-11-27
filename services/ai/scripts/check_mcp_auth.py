"""Checks MCP sign-in against the running local stack (Aspire), the way an assistant would do it: discovery, dynamic
client registration, a PKCE sign-in, the token's audience, and a tool call. Run by hand, not in CI:

    uv run python scripts/check_mcp_auth.py <users-file> <email>

The users file has one "email password" pair per line (a test account on the local realm). Nothing secret is printed.
Exits 1 if any check fails."""

import base64
import hashlib
import html
import json
import re
import secrets
import sys
from urllib.parse import parse_qs, urljoin, urlparse

import httpx

AI = "http://localhost:5085"
LEDGER = "http://localhost:5080"
REALM = "http://localhost:8180/realms/kitty"
REDIRECT = "http://localhost:33418/callback"
MCP_HEADERS = {"Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25"}

failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    failures += not ok
    print(f"{'PASS' if ok else 'FAIL'} {name}{f' ({detail})' if detail and not ok else ''}")


def claims(token: str) -> dict:
    body = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))


def register(redirect: str) -> httpx.Response:
    return httpx.post(
        f"{REALM}/clients-registrations/openid-connect",
        json={
            "client_name": "Kitty MCP check",
            "redirect_uris": [redirect],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        },
        timeout=20,
    )


def sign_in(client_id: str, email: str, password: str) -> str:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    with httpx.Client(follow_redirects=False, timeout=20) as c:
        r = c.get(
            f"{REALM}/protocol/openid-connect/auth",
            params={
                "client_id": client_id,
                "response_type": "code",
                "redirect_uri": REDIRECT,
                "scope": "openid kitty-mcp",
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "state": "s",
            },
        )
        action = html.unescape(re.search(r'action="([^"]+)"', r.text).group(1))
        # Keycloak's cookies are Secure, which httpx won't send over plain http://localhost: send them by hand.
        jar = lambda: "; ".join(f"{k}={v}" for k, v in c.cookies.items())  # noqa: E731
        r = c.post(
            action, data={"username": email, "password": password, "credentialId": ""}, headers={"Cookie": jar()}
        )
        location = r.headers.get("location", "")
        if location and "code=" not in location:  # Keycloak sends a consent screen next
            r = c.get(urljoin(str(r.url), location), headers={"Cookie": jar()})
            location = r.headers.get("location", "")
        if not location and r.status_code == 200 and "consent" in r.text.lower():
            consent = urljoin(str(r.url), html.unescape(re.search(r'action="([^"]+)"', r.text).group(1)))
            r = c.post(consent, data={"accept": "Yes"}, headers={"Cookie": jar()})
            location = r.headers.get("location", "")
        code = parse_qs(urlparse(location).query).get("code", [None])[0]
        if not code:
            raise SystemExit(f"FAIL sign-in (status {r.status_code})")
        t = c.post(
            f"{REALM}/protocol/openid-connect/token",
            data={
                "grant_type": "authorization_code",
                "client_id": client_id,
                "code": code,
                "redirect_uri": REDIRECT,
                "code_verifier": verifier,
            },
        )
        t.raise_for_status()
        return t.json()["access_token"]


def rpc(token: str, method: str, params: dict, id_: int) -> httpx.Response:
    return httpx.post(
        f"{AI}/mcp",
        json={"jsonrpc": "2.0", "id": id_, "method": method, "params": params},
        headers=MCP_HEADERS | {"Authorization": f"Bearer {token}"},
        timeout=30,
    )


def main() -> None:
    users = dict(line.split() for line in open(sys.argv[1], encoding="utf-8") if line.strip())
    email = sys.argv[2]

    r = httpx.post(f"{AI}/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, headers=MCP_HEADERS)
    expected = f'resource_metadata="{AI}/.well-known/oauth-protected-resource/mcp"'
    check(
        "1 /mcp without a token is 401 with resource metadata",
        r.status_code == 401 and expected in r.headers.get("www-authenticate", ""),
        f"{r.status_code} {r.headers.get('www-authenticate')}",
    )
    if r.status_code != 401:
        sys.exit(1)

    meta = httpx.get(f"{AI}/.well-known/oauth-protected-resource/mcp").json()
    check("2 metadata names the realm", meta.get("authorization_servers") == [REALM], str(meta))

    reg = register(REDIRECT)
    check("3 an assistant can register itself", reg.status_code == 201, f"{reg.status_code} {reg.text[:200]}")
    bad = register("https://evil.example/cb")
    check("4 an unknown redirect host is refused", bad.status_code >= 400, str(bad.status_code))
    if reg.status_code != 201:
        sys.exit(1)

    token = sign_in(reg.json()["client_id"], email, users[email])
    aud = claims(token).get("aud")
    aud = [aud] if isinstance(aud, str) else aud or []
    check("5 the token is for kitty-mcp and not the ledger", "kitty-mcp" in aud and "kitty-ledger" not in aud, str(aud))

    led = httpx.get(f"{LEDGER}/groups", headers={"Authorization": f"Bearer {token}"})
    check("6 the ledger refuses an assistant's token", led.status_code == 401, str(led.status_code))

    init = rpc(token, "initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                                     "clientInfo": {"name": "check", "version": "1"}}, 1)  # fmt: skip
    call = rpc(token, "tools/call", {"name": "list_groups", "arguments": {}}, 2)
    groups = (
        call.json().get("result", {}).get("structuredContent", {}).get("groups") if call.status_code == 200 else None
    )
    check(
        "7 list_groups works through the token exchange",
        init.status_code == 200 and isinstance(groups, list),
        f"{init.status_code} {call.status_code} {call.text[:300]}",
    )
    if isinstance(groups, list):
        print(f"     groups: {[g['name'] for g in groups]}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
