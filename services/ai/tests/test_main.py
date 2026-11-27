from fastapi.testclient import TestClient

from kitty_ai.main import create_app
from kitty_ai.settings import Settings


def test_health_without_kafka_reports_the_worker_off():
    with TestClient(create_app(Settings(kafka_bootstrap=""))) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "worker": "off"}


def test_health_is_unhealthy_when_the_worker_has_stopped():
    from types import SimpleNamespace

    stopped = SimpleNamespace(running=False, start=lambda: None, stop=lambda: None)
    app = create_app(Settings(kafka_bootstrap="kafka:9092"), make_worker=lambda settings: stopped)
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 503
    assert response.json() == {"status": "degraded", "worker": "stopped"}


def test_plain_entry_is_off_without_an_issuer():
    with TestClient(create_app(Settings(kafka_bootstrap="", auth_issuer=""))) as client:
        assert client.post("/parse", json={"text": "x"}).status_code == 404


def test_plain_entry_needs_a_token_once_on():
    settings = Settings(
        kafka_bootstrap="", auth_issuer="http://keycloak.test/realms/kitty", ledger_url="http://ledger.test"
    )
    with TestClient(create_app(settings)) as client:
        assert client.post("/parse", json={"text": "x"}).json() == {"code": "unauthorized"}


def test_mcp_is_mounted_with_its_metadata_when_configured():

    settings = Settings(
        auth_issuer="http://keycloak.test/realms/kitty",
        mcp_public_url="http://localhost:5085/mcp",
        ledger_url="x",
        mcp_client_secret="s",
        web_url="http://localhost:3000",
    )
    with TestClient(create_app(settings)) as client:
        r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        assert r.status_code == 401
        assert (
            'resource_metadata="http://localhost:5085/.well-known/oauth-protected-resource/mcp"'
            in (r.headers["www-authenticate"])
        )
        meta = client.get("/.well-known/oauth-protected-resource/mcp").json()
        assert meta["authorization_servers"] == ["http://keycloak.test/realms/kitty"]


def test_mcp_is_off_without_a_public_url():

    with TestClient(create_app(Settings(auth_issuer="http://keycloak.test/realms/kitty", ledger_url="x"))) as client:
        assert client.post("/mcp", json={}).status_code in (404, 405)


def test_mcp_settings_must_be_complete():
    import pytest

    base = {"auth_issuer": "http://keycloak.test/realms/kitty", "ledger_url": "x", "mcp_public_url": "http://h/mcp"}
    with pytest.raises(ValueError, match="AI_MCP_CLIENT_SECRET"):
        create_app(Settings(**base, web_url="http://w"))
    with pytest.raises(ValueError, match="AI_WEB_URL"):
        create_app(Settings(**base, mcp_client_secret="s"))
