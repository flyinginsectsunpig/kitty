import logging
from datetime import date

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kitty_ai.ask.agent import ModelTurn, ToolCall
from kitty_ai.ask.routes import make_ask_router
from kitty_ai.auth import TokenVerifier
from kitty_ai.entry.routes import make_router
from kitty_ai.entry.schema import ParsedSentence
from kitty_ai.receipts.extract import ModelUnavailable, RateLimited
from kitty_ai.settings import Settings
from tests.tokens import ISSUER, TestIssuer

G = "g-flat"
OWING = {"iOwe": [{"currency": "ZAR", "minor": 2500, "text": "R 25,00"}], "owedToMe": [], "people": [], "groups": []}
QUESTION = "How much do I owe Joe for the zebra ride?"
ANSWER = "You owe Joe R 25,00 for the zebra ride, in Flat 4B."


class FakeChat:
    def __init__(self, *turns: ModelTurn, error: Exception | None = None):
        self.turns, self.error, self.seen = list(turns), error, []

    def turn(self, system, steps, tools):
        self.seen.append((system, list(steps), tools))
        if self.error:
            raise self.error
        return self.turns.pop(0) if self.turns else ModelTurn(ANSWER, [])


def ledger(seen: list[httpx.Request]) -> httpx.Client:
    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        match request.url.path:
            case "/me":
                return httpx.Response(200, json={"id": "u-me", "displayName": "Zakhir", "email": None})
            case "/groups":
                group = {
                    "id": G,
                    "name": "Flat 4B",
                    "baseCurrency": "ZAR",
                    "memberCount": 2,
                    "myNet": [],
                    "createdAt": "2026-01-05T10:00:00+00:00",
                }
                return httpx.Response(200, json=[group])
            case "/me/owing":
                return httpx.Response(200, json=OWING)
        return httpx.Response(404, json={"code": "not_found"})

    return httpx.Client(transport=httpx.MockTransport(handle))


def app_with(chat, client: httpx.Client, keys: TestIssuer) -> TestClient:
    settings = Settings(ledger_url="http://ledger.test", auth_issuer=ISSUER)
    app = FastAPI()
    app.include_router(
        make_ask_router(
            settings, TokenVerifier(ISSUER, "kitty-ai", keys.jwks), chat, client, lambda: date(2026, 11, 25)
        )
    )
    test_client = TestClient(app)
    test_client.headers["Authorization"] = f"Bearer {keys.token(sub='user-1')}"
    return test_client


@pytest.fixture
def keys():
    return TestIssuer()


def ask(text: str = QUESTION, **extra) -> dict:
    return {"messages": [{"role": "person", "text": text}], **extra}


def test_ask_needs_a_token(keys):
    client = app_with(FakeChat(), ledger([]), keys)
    r = client.post("/ask", json=ask(), headers={"Authorization": ""})
    assert (r.status_code, r.json()) == (401, {"code": "unauthorized"})


def test_ask_returns_the_answer(keys):
    seen: list[httpx.Request] = []
    chat = FakeChat(ModelTurn(None, [ToolCall("what_i_owe", {}, "c1")]), ModelTurn(ANSWER, []))
    client = app_with(chat, ledger(seen), keys)

    r = client.post("/ask", json=ask(groupId=G))

    assert (r.status_code, r.json()) == (200, {"answer": ANSWER})
    system = chat.seen[0][0]
    assert "2026-11-25" in system and "Zakhir" in system and "Flat 4B" in system
    assert [r.url.path for r in seen] == ["/me", "/groups", "/me/owing"]
    assert all(r.headers["authorization"].startswith("Bearer ") for r in seen)


def test_entry_kind_when_not_a_question(keys):
    client = app_with(FakeChat(ModelTurn(None, [ToolCall("not_a_question", {}, "c1")])), ledger([]), keys)
    r = client.post("/ask", json=ask("petrol R600 with Sam"))
    assert (r.status_code, r.json()) == (200, {"kind": "entry"})


def test_last_message_must_be_the_persons(keys):
    client = app_with(FakeChat(), ledger([]), keys)
    body = {"messages": [{"role": "person", "text": "hi"}, {"role": "kitty", "text": "Hello"}]}
    r = client.post("/ask", json=body)
    assert (r.status_code, r.json()) == (400, {"code": "validation_failed"})


@pytest.mark.parametrize(
    "messages",
    [
        [],
        [{"role": "person", "text": "x"}] * 13,
        [{"role": "person", "text": "x" * 501}],
        [{"role": "person", "text": "   "}],
        [{"role": "kitty", "text": "y" * 4001}, {"role": "person", "text": "and?"}],
        [{"role": "robot", "text": "x"}],
    ],
)
def test_too_many_or_too_long_messages_is_400(keys, messages):
    client = app_with(FakeChat(), ledger([]), keys)
    r = client.post("/ask", json={"messages": messages})
    assert (r.status_code, r.json()) == (400, {"code": "validation_failed"})


def test_twelve_messages_are_fine(keys):
    chat = FakeChat()
    client = app_with(chat, ledger([]), keys)
    messages = [{"role": "person" if i % 2 == 0 else "kitty", "text": f"m{i}"} for i in range(11)]
    r = client.post("/ask", json={"messages": messages + [{"role": "person", "text": "last"}]})
    assert r.status_code == 200
    assert len(chat.seen[0][1]) == 12


def test_ask_limit_is_15_an_hour(keys):
    client = app_with(FakeChat(), ledger([]), keys)
    for _ in range(15):
        assert client.post("/ask", json=ask()).status_code == 200
    r = client.post("/ask", json=ask())
    assert (r.status_code, r.json()) == (429, {"code": "rate_limited"})


@pytest.mark.parametrize("error", [ModelUnavailable("off"), RateLimited("busy")])
def test_model_down_is_503(keys, error):
    client = app_with(FakeChat(error=error), ledger([]), keys)
    r = client.post("/ask", json=ask())
    assert (r.status_code, r.json()) == (503, {"code": "ai_unavailable"})


def test_blank_answer_is_unclear(keys):
    client = app_with(FakeChat(ModelTurn("  ", [])), ledger([]), keys)
    r = client.post("/ask", json=ask())
    assert (r.status_code, r.json()) == (422, {"code": "unclear"})


def test_ledger_down_is_503(keys):
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    client = app_with(FakeChat(), httpx.Client(transport=httpx.MockTransport(down)), keys)
    r = client.post("/ask", json=ask())
    assert (r.status_code, r.json()) == (503, {"code": "ai_unavailable"})


def test_nothing_said_is_logged(keys, caplog):
    chat = FakeChat(ModelTurn(None, [ToolCall("what_i_owe", {}, "c1")]), ModelTurn(ANSWER, []))
    client = app_with(chat, ledger([]), keys)
    with caplog.at_level(logging.DEBUG):
        assert client.post("/ask", json=ask()).status_code == 200
    assert "zebra" not in caplog.text.lower() and "R 25,00" not in caplog.text
    assert "what_i_owe" in caplog.text


def test_parse_says_question(keys):
    class QuestionParser:
        def parse(self, text, today, default_currency):
            return ParsedSentence.model_validate({"intent": "question"})

    settings = Settings(ledger_url="http://ledger.test", auth_issuer=ISSUER)
    app = FastAPI()
    app.include_router(
        make_router(settings, TokenVerifier(ISSUER, "kitty-ai", keys.jwks), QuestionParser(), ledger([]))
    )
    client = TestClient(app)

    r = client.post("/parse", json={"text": QUESTION}, headers={"Authorization": f"Bearer {keys.token()}"})

    assert r.status_code == 200
    body = r.json()
    assert (body["intent"], body["issues"], body["members"]) == ("question", [], [])


def test_search_text_in_a_lookup_is_not_logged(keys, caplog):
    from kitty_ai.main import create_app

    create_app(Settings())  # sets the log levels the running service uses
    chat = FakeChat(ModelTurn(None, [ToolCall("group_spending", {"group_id": G, "text": "zebra"}, "c1")]))
    client = app_with(chat, ledger([]), keys)
    with caplog.at_level(logging.DEBUG):
        assert client.post("/ask", json=ask("what did we spend on the zebra?")).status_code == 200
    assert "zebra" not in caplog.text.lower()
