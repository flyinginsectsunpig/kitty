import logging
from contextlib import asynccontextmanager
from datetime import date

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.routing import Route

from kitty_ai.auth import TokenVerifier
from kitty_ai.ledger import LedgerReader
from kitty_ai.limits import RateLimiter
from kitty_ai.mcp.auth import LedgerTokenExchanger
from kitty_ai.mcp.drafts import InMemoryDraftStore
from kitty_ai.mcp.server import build_mcp
from kitty_ai.settings import Settings
from tests.test_mcp_tools import G, reader
from tests.tokens import ISSUER, TestIssuer

VERSION = "2025-11-25"  # what Claude and ChatGPT send today; the SDK also speaks newer ones
HEADERS = {"Accept": "application/json, text/event-stream", "MCP-Protocol-Version": VERSION}
SETTINGS = Settings(
    auth_issuer=ISSUER, mcp_public_url="http://testserver/mcp", web_url="http://localhost:3000", ledger_url="x"
)


class FixedExchanger(LedgerTokenExchanger):
    def __init__(self):
        pass

    def exchange(self, subject_token: str) -> str:
        return "ledger-token"


@pytest.fixture
def rig():
    keys = TestIssuer()
    tokens_seen: list[str] = []

    def reader_for(token: str) -> LedgerReader:
        tokens_seen.append(token)
        return reader()

    mcp_app, sessions = build_mcp(
        SETTINGS,
        TokenVerifier(ISSUER, "kitty-mcp", keys.jwks),
        FixedExchanger(),
        reader_for,
        InMemoryDraftStore(),
        lambda: date(2026, 11, 27),
        drafts=RateLimiter(30, 3600),
    )

    @asynccontextmanager
    async def lifespan(_):
        async with sessions():
            yield

    app = FastAPI(lifespan=lifespan)
    app.router.routes.append(Route("/mcp", mcp_app, methods=["GET", "POST", "DELETE"]))
    with TestClient(app) as client:
        client.headers.update(HEADERS | {"Authorization": f"Bearer {keys.token(sub='user-1', aud='kitty-mcp')}"})
        yield client, tokens_seen


def rpc(client: TestClient, method: str, params: dict | None = None, id_: int = 1) -> dict:
    r = client.post("/mcp", json={"jsonrpc": "2.0", "id": id_, "method": method, "params": params or {}})
    assert r.status_code == 200, r.text
    return r.json()


def initialize(client: TestClient) -> None:
    rpc(
        client,
        "initialize",
        {"protocolVersion": VERSION, "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}},
    )


def call_tool(client: TestClient, name: str, arguments: dict, id_: int = 2) -> dict:
    return rpc(client, "tools/call", {"name": name, "arguments": arguments}, id_)["result"]


def test_tools_list_names_and_hints(rig):
    client, _ = rig
    initialize(client)
    listed = {t["name"]: t for t in rpc(client, "tools/list", id_=2)["result"]["tools"]}
    assert set(listed) == {
        "list_groups",
        "get_balances",
        "group_spending",
        "list_expenses",
        "draft_expense",
        "draft_payment",
        "draft_reminder",
    }
    assert listed["list_groups"]["annotations"]["readOnlyHint"] is True
    assert listed["draft_expense"]["annotations"]["readOnlyHint"] is False
    assert listed["draft_expense"]["annotations"]["destructiveHint"] is False
    assert {"from_date", "to_date"} <= set(listed["list_expenses"]["inputSchema"]["properties"])
    assert "what_for" in listed["draft_reminder"]["inputSchema"]["properties"]


def test_tools_call_list_groups(rig):
    client, tokens_seen = rig
    initialize(client)
    result = call_tool(client, "list_groups", {})
    assert result["structuredContent"]["groups"][0]["id"] == G
    assert tokens_seen == ["ledger-token"]


def test_tools_call_draft_reminder(rig):
    client, _ = rig
    initialize(client)
    result = call_tool(client, "draft_reminder", {"group": G, "person": "Bob", "what_for": "coffee", "amount": 20})
    assert result["structuredContent"]["link"].startswith("http://localhost:3000/d/")


def test_no_token_is_401(rig):
    client, _ = rig
    r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, headers={"Authorization": ""})
    assert r.status_code == 401
    assert "resource_metadata" in r.headers["www-authenticate"]


def test_rate_limited_draft(rig):
    client, _ = rig
    initialize(client)
    args = {"group": G, "description": "Dinner", "amount": 10, "people": [{"name": "me"}]}
    for i in range(30):
        assert "link" in call_tool(client, "draft_expense", args, id_=10 + i)["structuredContent"]
    assert call_tool(client, "draft_expense", args, id_=99)["structuredContent"] == {"error": "rate_limited"}


def test_logs_have_no_arguments(rig, caplog):
    client, _ = rig
    initialize(client)
    with caplog.at_level(logging.INFO, logger="kitty_ai.mcp.server"):
        call_tool(client, "draft_expense", {"group": G, "description": "Secret dinner", "amount": 10})
    text = caplog.text
    assert "tool=draft_expense" in text and "sub=user-1" in text
    assert "Secret dinner" not in text
