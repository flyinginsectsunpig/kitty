import httpx
import pytest

from kitty_ai.ask.tools import TOOLS, NotAQuestion, run_tool
from kitty_ai.ledger import LedgerReader

G1 = "22222222-2222-2222-2222-222222222222"
OWING = {"iOwe": [{"currency": "ZAR", "minor": 12000, "text": "R 120,00"}], "owedToMe": [], "people": [], "groups": []}
SPENDING = {"groupCurrency": "ZAR", "currencies": [], "converted": None}


def ledger(seen: list[httpx.Request], status: int = 200) -> LedgerReader:
    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        match request.url.path:
            case "/groups":
                return httpx.Response(
                    200,
                    json=[
                        {
                            "id": G1,
                            "name": "Flat 4B",
                            "baseCurrency": "ZAR",
                            "memberCount": 2,
                            "myNet": [],
                            "createdAt": "2026-01-05T10:00:00+00:00",
                        }
                    ],
                )
            case "/me/owing":
                return httpx.Response(200, json=OWING)
            case p if p == f"/groups/{G1}/spending":
                return httpx.Response(status, json=SPENDING if status == 200 else {"code": "validation_failed"})
        return httpx.Response(404, json={"code": "not_found"})

    client = httpx.Client(base_url="http://ledger.test", transport=httpx.MockTransport(handle))
    return LedgerReader("http://ledger.test", "tok-1", client)


def test_tools_are_exactly_the_four_read_only_lookups():
    assert [t.name for t in TOOLS] == ["list_groups", "what_i_owe", "group_spending", "not_a_question"]
    assert all(t.description and t.parameters["type"] == "object" for t in TOOLS)


def test_list_groups_maps_names_ids_currency_created():
    assert run_tool(ledger([]), "list_groups", {}) == {
        "groups": [{"id": G1, "name": "Flat 4B", "currency": "ZAR", "createdAt": "2026-01-05T10:00:00+00:00"}]
    }


def test_what_i_owe_returns_the_ledger_json():
    assert run_tool(ledger([]), "what_i_owe", {}) == OWING


def test_group_spending_passes_filters_as_query():
    seen: list[httpx.Request] = []
    args = {"group_id": G1, "from": "2026-08-25", "to": "2026-11-25", "category": "groceries", "text": "woolies"}

    assert run_tool(ledger(seen), "group_spending", args) == SPENDING

    [r] = seen
    assert dict(r.url.params) == {"from": "2026-08-25", "to": "2026-11-25", "category": "groceries", "q": "woolies"}


def test_group_spending_leaves_out_missing_filters():
    seen: list[httpx.Request] = []
    run_tool(ledger(seen), "group_spending", {"group_id": G1})
    assert dict(seen[0].url.params) == {}


def test_group_spending_not_found_is_a_result():
    other = "99999999-9999-9999-9999-999999999999"
    assert run_tool(ledger([]), "group_spending", {"group_id": other}) == {"error": "not_found"}


def test_ledger_400_is_bad_arguments():
    assert run_tool(ledger([], status=400), "group_spending", {"group_id": G1}) == {"error": "bad_arguments"}


def test_ledger_down_propagates():
    with pytest.raises(httpx.HTTPError):
        run_tool(ledger([], status=503), "group_spending", {"group_id": G1})


@pytest.mark.parametrize(
    "args",
    [
        {"group_id": G1, "from": "25 Aug"},
        {"group_id": G1, "to": "2026-13-01"},
        {"group_id": G1, "from": "2026-11-25", "to": "2026-11-01"},
        {"group_id": G1, "category": "yachts"},
        {"group_id": G1, "text": "x" * 101},
        {"group_id": G1, "colour": "red"},
        {"from": "2026-11-01"},
        {"group_id": 7},
    ],
)
def test_bad_date_or_category_is_bad_arguments_without_calling(args):
    seen: list[httpx.Request] = []
    assert run_tool(ledger(seen), "group_spending", args) == {"error": "bad_arguments"}
    assert seen == []


def test_unknown_tool_is_a_result():
    seen: list[httpx.Request] = []
    assert run_tool(ledger(seen), "add_expense", {"amount": 5}) == {"error": "unknown_tool"}
    assert seen == []


def test_not_a_question_raises():
    with pytest.raises(NotAQuestion):
        run_tool(ledger([]), "not_a_question", {})


def test_lookups_use_the_callers_token():
    seen: list[httpx.Request] = []
    reader = ledger(seen)
    run_tool(reader, "list_groups", {})
    run_tool(reader, "what_i_owe", {})
    run_tool(reader, "group_spending", {"group_id": G1})
    assert len(seen) == 3
    assert all(r.headers["authorization"] == "Bearer tok-1" for r in seen)


def test_not_a_question_excludes_changing_an_existing_expense():
    spec = next(t for t in TOOLS if t.name == "not_a_question")
    # With the rule only in the prompt, Gemini still called it for "Cross off the Uber for Joe, I paid him".
    wanted = "Never call it to cross off, mark as paid, delete or change an existing expense or payment"
    assert wanted in spec.description
