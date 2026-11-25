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
