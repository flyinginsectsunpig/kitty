from datetime import date

import httpx

from kitty_ai.ledger import LedgerReader
from kitty_ai.mcp import tools
from kitty_ai.mcp.drafts import InMemoryDraftStore

ME_U, ME_M, SAM_M, BOB_M = "u-me", "m-me", "m-sam", "m-bob"
G = "g-flat"
WEB = "http://localhost:3000"
TODAY = date(2026, 11, 27)
LINES = {"items": [], "nextCursor": None}
BALANCES = {"currencies": []}
OWING = {"iOwe": [], "owedToMe": [], "people": [], "groups": []}
UBER = {
    "item": {
        "expenseId": "e-uber",
        "description": "Uber",
        "date": "2026-11-18",
        "category": "transport",
        "total": {"currency": "ZAR", "minor": 5000, "text": "R 50,00"},
        "myShare": {"currency": "ZAR", "minor": 2500, "text": "R 25,00"},
        "paidBy": "Bob",
    },
    "open": {"currency": "ZAR", "minor": 2500, "text": "R 25,00"},
}


def reader(seen: list[httpx.Request] | None = None) -> LedgerReader:
    seen = seen if seen is not None else []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        match request.url.path:
            case "/me":
                return httpx.Response(200, json={"id": ME_U, "displayName": "Zakhir", "email": None})
            case "/me/owing":
                return httpx.Response(200, json=OWING)
            case "/groups":
                return httpx.Response(
                    200,
                    json=[{"id": G, "name": "Flat 4B", "baseCurrency": "ZAR", "createdAt": "2026-01-05T10:00:00Z"}],
                )
            case "/groups/g-flat":
                members = [
                    {"id": ME_M, "displayName": "Zakhir", "userId": ME_U},
                    {"id": SAM_M, "displayName": "Sam", "userId": None},
                    {"id": BOB_M, "displayName": "Bob", "userId": "u-bob"},
                ]
                return httpx.Response(200, json={"id": G, "name": "Flat 4B", "baseCurrency": "ZAR", "members": members})
            case "/groups/g-flat/balances":
                return httpx.Response(200, json=BALANCES)
            case "/groups/g-flat/expense-lines":
                return httpx.Response(200, json=LINES)
            case "/groups/g-flat/spending":
                return httpx.Response(200, json={"groupCurrency": "ZAR", "currencies": [], "converted": None})
            case "/groups/g-flat/open-items":
                body = {
                    "fromMemberId": ME_M,
                    "toMemberId": BOB_M,
                    "currencies": [{"currency": "ZAR", "fromOwes": [UBER]}],
                }
                return httpx.Response(200, json=body)
        return httpx.Response(404, json={"code": "not_found"})

    return LedgerReader("http://ledger.test", "ledger-token", httpx.Client(transport=httpx.MockTransport(handle)))


def test_list_groups_has_members():
    assert tools.list_groups(reader(), {}) == {
        "groups": [
            {
                "id": G,
                "name": "Flat 4B",
                "currency": "ZAR",
                "members": [
                    {"name": "Zakhir", "hasAccount": True},
                    {"name": "Sam", "hasAccount": False},
                    {"name": "Bob", "hasAccount": True},
                ],
            }
        ]
    }


def test_get_balances_all_and_one_group():
    assert tools.get_balances(reader(), {}) == OWING
    assert tools.get_balances(reader(), {"group": "flat"}) == {
        "group": {"id": G, "name": "Flat 4B"},
        "balances": BALANCES,
    }


def test_group_spending_checks_arguments():
    assert tools.group_spending(reader(), {"group": G, "from": "2026-11-01"})["groupCurrency"] == "ZAR"
    assert tools.group_spending(reader(), {"group": G, "from": "yesterday"}) == {
        "error": "bad_arguments",
        "detail": "from",
    }


def test_list_expenses_maps_person_to_member_id():
    seen: list[httpx.Request] = []
    assert tools.list_expenses(reader(seen), {"group": "Flat 4B", "person": "sam", "text": "pizza"}) == LINES
    sent = next(r for r in seen if r.url.path.endswith("/expense-lines"))
    assert dict(sent.url.params) == {"q": "pizza", "member": SAM_M, "limit": "20"}
    assert tools.list_expenses(reader(), {"group": G, "person": "Nobody"}) == {
        "error": "bad_arguments",
        "detail": "person",
    }


def test_other_group_is_not_found():
    assert tools.get_balances(reader(), {"group": "g-someone-elses"}) == {
        "error": "bad_arguments",
        "detail": "group",
        "groups": [{"id": G, "name": "Flat 4B"}],
    }
    # An id that looks valid but isn't one of the person's groups never reaches the ledger as theirs.
    seen: list[httpx.Request] = []
    tools.list_expenses(reader(seen), {"group": "g-other"})
    assert not any("g-other" in r.url.path for r in seen)


def test_draft_expense_stores_and_links():
    store = InMemoryDraftStore()
    args = {"group": "Flat 4B", "description": "Dinner", "amount": 450, "people": [{"name": "me"}, {"name": "Sam"}]}
    out = tools.draft(reader(), store, "user-1", WEB, "expense", args, TODAY)
    assert out["link"].startswith(f"{WEB}/d/")
    assert out["issues"] == []
    assert "Dinner" in out["summary"]
    saved = store.get(out["link"].rsplit("/", 1)[1], "user-1")
    assert saved is not None and saved.group_id == G and saved.parsed.amount == "450"


def test_draft_with_unknown_group_returns_groups_and_no_link():
    store = InMemoryDraftStore()
    out = tools.draft(reader(), store, "user-1", WEB, "expense", {"group": "Holiday", "amount": 10}, TODAY)
    assert out["link"] is None
    assert out["issues"][0]["field"] == "group"
    assert out["groups"] == [{"id": G, "name": "Flat 4B"}]


def test_draft_with_issue_still_links():
    out = tools.draft(
        reader(),
        InMemoryDraftStore(),
        "user-1",
        WEB,
        "expense",
        {"group": G, "description": "Dinner", "amount": "450", "people": [{"name": "Sem"}]},
        TODAY,
    )
    assert out["link"] is not None
    assert {"field": "people[0]", "kind": "no_match"}.items() <= out["issues"][0].items()


def test_draft_payment_and_reminder_shapes():
    store = InMemoryDraftStore()
    pay = tools.draft(
        reader(),
        store,
        "user-1",
        WEB,
        "payment",
        {"group": G, "direction": "i_paid", "counterpart": "Bob", "items": ["Uber"]},
        TODAY,
    )
    assert pay["summary"].startswith("Payment in Flat 4B: you pay Bob")
    assert store.get(pay["link"].rsplit("/", 1)[1], "user-1").parsed.intent == "payment"

    remind = tools.draft(
        reader(), store, "user-1", WEB, "reminder", {"group": G, "person": "Bob", "for": "coffee", "amount": 20}, TODAY
    )
    parsed = store.get(remind["link"].rsplit("/", 1)[1], "user-1").parsed
    assert parsed.intent == "reminder"
    assert [p.name for p in parsed.people] == ["Bob"]
    assert parsed.description == "coffee" and parsed.reminder_amount == "20"


def test_draft_bad_arguments():
    out = tools.draft(reader(), InMemoryDraftStore(), "user-1", WEB, "payment", {"group": G, "direction": "up"}, TODAY)
    assert out == {"error": "bad_arguments", "detail": "direction"}


def broken_ledger(status: int) -> LedgerReader:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/groups":
            return httpx.Response(200, json=[{"id": G, "name": "Flat 4B", "baseCurrency": "ZAR", "createdAt": ""}])
        return httpx.Response(status, json={"code": "boom"})

    return LedgerReader("http://ledger.test", "t", httpx.Client(transport=httpx.MockTransport(handle)))


def test_ledger_failure_is_a_result_without_the_search_text(caplog):
    import logging

    # httpx's own request log is silenced by the app (main.py); this checks Kitty's own, and that no exception (whose
    # text has the URL) reaches the MCP SDK, which would log it and send it to the assistant.
    with caplog.at_level(logging.DEBUG, logger="kitty_ai"):
        out = tools.list_expenses(broken_ledger(500), {"group": G, "text": "dinner with sam"})
    assert out == {"error": "unavailable"}
    assert "dinner" not in caplog.text
    assert "expense-lines" not in caplog.text


def test_ledger_unreachable_is_a_result():
    def handle(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    reader = LedgerReader("http://ledger.test", "t", httpx.Client(transport=httpx.MockTransport(handle)))
    assert tools.list_groups(reader, {}) == {"error": "unavailable"}


def test_draft_inputs_are_size_capped_and_nothing_is_stored():
    store = InMemoryDraftStore()
    cases = {
        "description": {"description": "x" * 121},
        "people": {"people": [{"name": f"p{i}"} for i in range(21)]},
        "people[0].name": {"people": [{"name": "n" * 101}]},
        "payer": {"payer": "p" * 101},
    }
    for field, extra in cases.items():
        args = {"group": G, "description": "Dinner", "amount": 10} | extra
        assert tools.draft(reader(), store, "user-1", WEB, "expense", args, TODAY) == {
            "error": "bad_arguments",
            "detail": field,
        }
    items = {"group": G, "direction": "i_paid", "counterpart": "Bob", "items": ["x"] * 11}
    assert tools.draft(reader(), store, "user-1", WEB, "payment", items, TODAY)["detail"] == "items"
    long_item = items | {"items": ["y" * 101]}
    assert tools.draft(reader(), store, "user-1", WEB, "payment", long_item, TODAY)["detail"] == "items[0]"
    assert store._drafts == {}
