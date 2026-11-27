from urllib.parse import parse_qs

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

from kitty_ai.auth import TokenVerifier, Unauthorized
from kitty_ai.mcp.auth import CURRENT, LedgerTokenExchanger, McpAuth, McpCaller
from kitty_ai.mcp.metadata import make_metadata_router, metadata_url, protected_resource
from kitty_ai.settings import Settings
from tests.tokens import ISSUER, TestIssuer

PUBLIC = Settings(mcp_public_url="https://h/ai/mcp", auth_issuer="https://h/auth/realms/kitty")
META = "https://h/.well-known/oauth-protected-resource/ai/mcp"
TOKEN_URL = f"{ISSUER}/protocol/openid-connect/token"


def test_metadata_shape_and_paths():
    app = FastAPI()
    app.include_router(make_metadata_router(PUBLIC))
    client = TestClient(app)
    expected = {
        "resource": "https://h/ai/mcp",
        "authorization_servers": ["https://h/auth/realms/kitty"],
        "scopes_supported": ["kitty-mcp"],
        "bearer_methods_supported": ["header"],
        "resource_name": "Kitty",
    }
    assert protected_resource(PUBLIC) == expected
    assert client.get("/.well-known/oauth-protected-resource").json() == expected
    assert client.get("/.well-known/oauth-protected-resource/ai/mcp").json() == expected


def test_metadata_url_appends_the_path():
    assert metadata_url(PUBLIC) == META
    local = Settings(mcp_public_url="http://localhost:5085/mcp")
    assert metadata_url(local) == "http://localhost:5085/.well-known/oauth-protected-resource/mcp"


class FakeKeycloak:
    def __init__(self, status: int = 200, expires_in: int = 300):
        self.status, self.expires_in, self.forms = status, expires_in, []

    def client(self) -> httpx.Client:
        def handle(request: httpx.Request) -> httpx.Response:
            assert str(request.url) == TOKEN_URL
            self.forms.append({k: v[0] for k, v in parse_qs(request.content.decode()).items()})
            if self.status != 200:
                return httpx.Response(self.status, json={"error": "invalid_request"})
            return httpx.Response(200, json={"access_token": "ledger-token", "expires_in": self.expires_in})

        return httpx.Client(transport=httpx.MockTransport(handle))


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def rig(keycloak: FakeKeycloak, clock: Clock | None = None):
    keys = TestIssuer()
    exchanger = LedgerTokenExchanger(TOKEN_URL, "kitty-mcp", "secret", keycloak.client(), clock or Clock())

    async def whoami(request):
        caller = CURRENT.get()
        return JSONResponse({"sub": caller.sub, "ledger": caller.ledger_token})

    inner = Starlette(routes=[Route("/", whoami, methods=["GET", "POST"])])
    app = McpAuth(inner, TokenVerifier(ISSUER, "kitty-mcp", keys.jwks), exchanger, META)
    return TestClient(app), keys, exchanger


def test_no_token_401_with_resource_metadata():
    client, _, _ = rig(FakeKeycloak())
    r = client.post("/")
    assert r.status_code == 401
    assert r.json() == {"code": "unauthorized"}
    assert r.headers["www-authenticate"] == f'Bearer resource_metadata="{META}", scope="kitty-mcp"'


def test_wrong_audience_401():
    client, keys, _ = rig(FakeKeycloak())
    r = client.post("/", headers={"Authorization": f"Bearer {keys.token(aud='kitty-ai')}"})
    assert r.status_code == 401
    assert "resource_metadata" in r.headers["www-authenticate"]


def test_expired_401():
    client, keys, _ = rig(FakeKeycloak())
    r = client.post("/", headers={"Authorization": f"Bearer {keys.token(aud='kitty-mcp', exp_in=-120)}"})
    assert r.status_code == 401


def test_valid_token_sets_caller_with_exchanged_token():
    keycloak = FakeKeycloak()
    client, keys, _ = rig(keycloak)
    token = keys.token(sub="user-1", aud="kitty-mcp")
    r = client.post("/", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json() == {"sub": "user-1", "ledger": "ledger-token"}
    form = keycloak.forms[0]
    assert form["grant_type"] == "urn:ietf:params:oauth:grant-type:token-exchange"
    assert form["subject_token"] == token
    assert form["subject_token_type"] == "urn:ietf:params:oauth:token-type:access_token"
    assert form["requested_token_type"] == "urn:ietf:params:oauth:token-type:access_token"
    assert form["audience"] == "kitty-ledger"
    assert form["client_id"] == "kitty-mcp"
    assert form["client_secret"] == "secret"


def test_exchange_is_cached_until_near_expiry():
    keycloak, clock = FakeKeycloak(expires_in=300), Clock()
    _, _, exchanger = rig(keycloak, clock)
    assert exchanger.exchange("subject") == "ledger-token"
    assert exchanger.exchange("subject") == "ledger-token"
    assert len(keycloak.forms) == 1
    clock.t += 300 - 29
    exchanger.exchange("subject")
    assert len(keycloak.forms) == 2


def test_exchange_refused_raises_unauthorized():
    _, _, exchanger = rig(FakeKeycloak(status=400))
    with pytest.raises(Unauthorized):
        exchanger.exchange("subject")


def test_exchange_refused_is_401():
    client, keys, _ = rig(FakeKeycloak(status=400))
    r = client.post("/", headers={"Authorization": f"Bearer {keys.token(aud='kitty-mcp')}"})
    assert r.status_code == 401


def test_caller_is_a_value():
    assert McpCaller("s", "t") == McpCaller("s", "t")
