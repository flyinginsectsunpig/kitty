from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kitty_ai.auth import TokenVerifier
from kitty_ai.mcp.draft_routes import make_draft_router
from kitty_ai.mcp.drafts import DRAFT_TTL, InMemoryDraftStore
from kitty_ai.settings import Settings
from tests.test_entry_routes import EXPENSE, G, ledger_client
from tests.tokens import ISSUER, TestIssuer

T0 = datetime(2026, 11, 27, 9, 0, tzinfo=UTC)


class Clock:
    def __init__(self):
        self.now = T0

    def __call__(self) -> datetime:
        return self.now


@pytest.fixture
def rig():
    keys, clock = TestIssuer(), Clock()
    store = InMemoryDraftStore(clock)
    settings = Settings(ledger_url="http://ledger.test", auth_issuer=ISSUER)
    app = FastAPI()
    verifier = TokenVerifier(ISSUER, "kitty-ai", keys.jwks)
    app.include_router(make_draft_router(settings, verifier, store, ledger_client(), lambda: date(2026, 11, 27)))
    client = TestClient(app)

    def as_(sub: str) -> dict:
        return {"Authorization": f"Bearer {keys.token(sub=sub)}"}

    return client, store, clock, as_


def test_get_returns_the_resolved_card(rig):
    client, store, _, as_ = rig
    draft_id = store.save("user-1", G, EXPENSE)
    r = client.get(f"/drafts/{draft_id}", headers=as_("user-1"))
    assert r.status_code == 200
    body = r.json()
    assert body["intent"] == "expense"
    assert body["groupId"] == G
    assert body["parsed"]["description"] == "Dinner"
    assert body["groups"] == [{"id": G, "name": "Flat 4B"}]


def test_other_person_gets_404(rig):
    client, store, _, as_ = rig
    draft_id = store.save("user-1", G, EXPENSE)
    assert client.get(f"/drafts/{draft_id}", headers=as_("user-2")).status_code == 404


def test_expired_gets_404(rig):
    client, store, clock, as_ = rig
    draft_id = store.save("user-1", G, EXPENSE)
    clock.now = T0 + DRAFT_TTL + timedelta(seconds=1)
    assert client.get(f"/drafts/{draft_id}", headers=as_("user-1")).status_code == 404


def test_delete_then_get_404(rig):
    client, store, _, as_ = rig
    draft_id = store.save("user-1", G, EXPENSE)
    assert client.delete(f"/drafts/{draft_id}", headers=as_("user-1")).status_code == 204
    assert client.get(f"/drafts/{draft_id}", headers=as_("user-1")).status_code == 404
    assert client.delete(f"/drafts/{draft_id}", headers=as_("user-1")).status_code == 204


def test_someone_else_cannot_delete(rig):
    client, store, _, as_ = rig
    draft_id = store.save("user-1", G, EXPENSE)
    assert client.delete(f"/drafts/{draft_id}", headers=as_("user-2")).status_code == 204
    assert client.get(f"/drafts/{draft_id}", headers=as_("user-1")).status_code == 200


def test_needs_token(rig):
    client, store, _, _ = rig
    draft_id = store.save("user-1", G, EXPENSE)
    assert client.get(f"/drafts/{draft_id}").status_code == 401
    assert client.delete(f"/drafts/{draft_id}").status_code == 401


def test_ids_are_unguessable(rig):
    _, store, _, _ = rig
    a, b = store.save("user-1", G, EXPENSE), store.save("user-1", G, EXPENSE)
    assert a != b
    assert len(a) >= 22


@pytest.mark.slow
def test_postgres_store_round_trip():
    from testcontainers.postgres import PostgresContainer

    from kitty_ai.mcp.drafts import PostgresDraftStore
    from tests.conftest import POSTGRES

    clock = Clock()
    with PostgresContainer(POSTGRES, driver=None) as pg:
        store = PostgresDraftStore(pg.get_connection_url(), clock)
        draft_id = store.save("user-1", G, EXPENSE)
        got = store.get(draft_id, "user-1")
        assert got is not None and got.group_id == G and got.parsed == EXPENSE
        assert store.get(draft_id, "user-2") is None
        clock.now = T0 + DRAFT_TTL + timedelta(seconds=1)
        assert store.get(draft_id, "user-1") is None
        clock.now = T0
        store.delete(draft_id, "user-1")
        assert store.get(draft_id, "user-1") is None
