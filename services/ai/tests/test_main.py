from fastapi.testclient import TestClient

from kitty_ai.main import create_app
from kitty_ai.settings import Settings


def test_health_without_kafka_reports_the_worker_off():
    with TestClient(create_app(Settings(kafka_bootstrap=""))) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "worker": "off"}
