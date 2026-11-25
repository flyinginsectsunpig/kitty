import logging
from datetime import date

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kitty_ai.auth import TokenVerifier
from kitty_ai.entry.routes import make_router
from kitty_ai.entry.schema import ParsedSentence
from kitty_ai.receipts.extract import ModelUnavailable
from kitty_ai.settings import Settings
from tests.tokens import ISSUER, TestIssuer

ME_U, ME_M, BOB_M = "u-me", "m-me", "m-bob"
G = "g-flat"
SENTENCE = "dinner R300 with Bob, I paid"


class FakeParser:
    def __init__(self, result=None, error=None):
        self.result, self.error, self.calls = result, error, []

    def parse(self, text, today, default_currency):
        self.calls.append((text, today, default_currency))
        if self.error:
            raise self.error
        return self.result


def ledger_client() -> httpx.Client:
    def handle(request: httpx.Request) -> httpx.Response:
        match request.url.path:
            case "/me":
                return httpx.Response(200, json={"id": ME_U, "displayName": "Zakhir", "email": None})
            case "/groups":
                groups = [{"id": G, "name": "Flat 4B", "baseCurrency": "ZAR", "memberCount": 2, "myNet": []}]
                return httpx.Response(200, json=groups)
            case "/groups/g-flat":
                members = [
                    {
                        "id": ME_M,
                        "displayName": "Zakhir",
                        "userId": ME_U,
                        "isPlaceholder": False,
                        "paymentDetails": None,
                    },
                    {
                        "id": BOB_M,
                        "displayName": "Bob",
                        "userId": "u-bob",
                        "isPlaceholder": False,
                        "paymentDetails": None,
                    },
                ]
                return httpx.Response(200, json={"id": G, "name": "Flat 4B", "baseCurrency": "ZAR", "members": members})
        return httpx.Response(404, json={"code": "not_found"})

    return httpx.Client(transport=httpx.MockTransport(handle))


EXPENSE = ParsedSentence.model_validate(
    {"intent": "expense", "description": "Dinner", "amount": "300", "people": [{"name": "me"}, {"name": "Bob"}]}
)


@pytest.fixture
def rig():
    keys = TestIssuer()
    parser = FakeParser(EXPENSE)
    settings = Settings(ledger_url="http://ledger.test", auth_issuer=ISSUER)
    app = FastAPI()
    app.include_router(
        make_router(
            settings, TokenVerifier(ISSUER, "kitty-ai", keys.jwks), parser, ledger_client(), lambda: date(2026, 11, 25)
        )
    )
    client = TestClient(app)
    client.headers["Authorization"] = f"Bearer {keys.token(sub='user-1')}"
    return client, parser, keys


def test_parse_needs_a_token(rig):
    client, _, _ = rig
    r = client.post("/parse", json={"text": SENTENCE}, headers={"Authorization": ""})
    assert (r.status_code, r.json()) == (401, {"code": "unauthorized"})


def test_parse_returns_draft_groups_members_and_parsed(rig):
    client, parser, _ = rig
    r = client.post("/parse", json={"text": SENTENCE, "groupId": G})
    assert r.status_code == 200
    body = r.json()
    assert body["intent"] == "expense" and body["groupId"] == G
    assert body["expense"]["amountMinor"] == 30000
    assert [p["memberId"] for p in body["expense"]["participants"]] == [ME_M, BOB_M]
    assert body["groups"] == [{"id": G, "name": "Flat 4B"}]
    assert body["members"][1] == {"id": BOB_M, "displayName": "Bob"}
    assert body["parsed"]["amount"] == "300"
    assert parser.calls == [(SENTENCE, date(2026, 11, 25), "ZAR")]


def test_resolve_rematches_without_the_model(rig):
    client, parser, _ = rig
    r = client.post("/resolve", json={"parsed": EXPENSE.model_dump(mode="json"), "groupId": G})
    assert r.status_code == 200 and r.json()["expense"]["amountMinor"] == 30000
    assert parser.calls == []


def test_a_group_the_person_cant_see_is_404(rig):
    client, _, _ = rig
    r = client.post("/resolve", json={"parsed": EXPENSE.model_dump(mode="json"), "groupId": "g-other"})
    assert (r.status_code, r.json()) == (404, {"code": "not_found"})


def test_text_must_be_1_to_500_characters(rig):
    client, _, _ = rig
    assert client.post("/parse", json={"text": ""}).status_code == 400
    assert client.post("/parse", json={"text": "x" * 501}).json() == {"code": "validation_failed"}


def test_parse_limit_is_429(rig):
    client, _, _ = rig
    for _ in range(30):
        assert client.post("/parse", json={"text": SENTENCE}).status_code == 200
    r = client.post("/parse", json={"text": SENTENCE})
    assert (r.status_code, r.json()) == (429, {"code": "rate_limited"})


def test_model_down_is_503(rig):
    client, parser, _ = rig
    parser.error = ModelUnavailable("down")
    r = client.post("/parse", json={"text": SENTENCE})
    assert (r.status_code, r.json()) == (503, {"code": "ai_unavailable"})


def test_a_model_failure_is_logged_without_the_sentence(rig, caplog):
    client, parser, _ = rig
    parser.error = ModelUnavailable("Gemini said: dinner R300 with Bob is bad")
    with caplog.at_level(logging.WARNING):
        client.post("/parse", json={"text": SENTENCE})
    assert "ModelUnavailable" in caplog.text and "dinner" not in caplog.text.lower()


def test_sentence_is_not_logged(rig, caplog):
    client, _, _ = rig
    with caplog.at_level(logging.DEBUG):
        client.post("/parse", json={"text": SENTENCE})
    assert "dinner" not in caplog.text.lower()


def test_ledger_down_is_503():
    keys = TestIssuer()

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    app = FastAPI()
    settings = Settings(ledger_url="http://ledger.test", auth_issuer=ISSUER)
    app.include_router(
        make_router(
            settings,
            TokenVerifier(ISSUER, "kitty-ai", keys.jwks),
            FakeParser(EXPENSE),
            httpx.Client(transport=httpx.MockTransport(down)),
        )
    )
    r = TestClient(app).post("/parse", json={"text": SENTENCE}, headers={"Authorization": f"Bearer {keys.token()}"})
    assert (r.status_code, r.json()) == (503, {"code": "ai_unavailable"})
