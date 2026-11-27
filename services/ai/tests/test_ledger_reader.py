import httpx
import pytest

from kitty_ai.ledger import LedgerReader, NotFound

ME = "11111111-1111-1111-1111-111111111111"
G1 = "22222222-2222-2222-2222-222222222222"
OWNER_M, BOB_M = "33333333-3333-3333-3333-333333333333", "44444444-4444-4444-4444-444444444444"


def fake_ledger(seen: list[httpx.Request]) -> httpx.Client:
    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        match request.url.path:
            case "/me":
                return httpx.Response(200, json={"id": ME, "displayName": "Zakhir", "email": None})
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
            case p if p == f"/groups/{G1}":
                return httpx.Response(
                    200,
                    json={
                        "id": G1,
                        "name": "Flat 4B",
                        "baseCurrency": "ZAR",
                        "members": [
                            {
                                "id": OWNER_M,
                                "displayName": "Zakhir",
                                "userId": ME,
                                "isPlaceholder": False,
                                "paymentDetails": None,
                            },
                            {
                                "id": BOB_M,
                                "displayName": "Bob",
                                "userId": None,
                                "isPlaceholder": True,
                                "paymentDetails": None,
                            },
                        ],
                    },
                )
            case p if p == f"/groups/{G1}/balances":
                return httpx.Response(
                    200,
                    json={
                        "converted": None,
                        "currencies": [
                            {
                                "currency": "EUR",
                                "members": [],
                                "transfers": [{"fromMemberId": BOB_M, "toMemberId": OWNER_M, "amountMinor": 2000}],
                            },
                            {
                                "currency": "ZAR",
                                "members": [],
                                "transfers": [
                                    {"fromMemberId": BOB_M, "toMemberId": OWNER_M, "amountMinor": 15000},
                                    {"fromMemberId": BOB_M, "toMemberId": "someone-else", "amountMinor": 500},
                                ],
                            },
                        ],
                    },
                )
        return httpx.Response(404, json={"code": "not_found"})

    return httpx.Client(base_url="http://ledger.test", transport=httpx.MockTransport(handle))


def test_reader_sends_the_callers_token_and_maps_groups():
    seen: list[httpx.Request] = []
    reader = LedgerReader("http://ledger.test", "tok-1", fake_ledger(seen))
    assert reader.me().id == ME
    [g] = reader.groups()
    assert (g.id, g.name, g.base_currency, g.created_at) == (G1, "Flat 4B", "ZAR", "2026-01-05T10:00:00+00:00")
    group = reader.group(G1)
    assert [(m.display_name, m.user_id) for m in group.members] == [("Zakhir", ME), ("Bob", None)]
    assert all(r.headers["authorization"] == "Bearer tok-1" for r in seen)


def test_owed_to_me_sums_transfers_per_currency():
    reader = LedgerReader("http://ledger.test", "tok-1", fake_ledger([]))
    assert reader.owed_to_me(G1, OWNER_M, BOB_M) == {"EUR": 2000, "ZAR": 15000}


def test_a_group_the_ledger_hides_is_not_found():
    reader = LedgerReader("http://ledger.test", "tok-1", fake_ledger([]))
    with pytest.raises(NotFound):
        reader.group("99999999-9999-9999-9999-999999999999")


def test_open_items_reads_both_members():
    seen: list[httpx.Request] = []
    body = {"fromMemberId": "m1", "toMemberId": "m2", "currencies": []}

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=body)

    reader = LedgerReader("http://ledger.test", "tok-1", httpx.Client(transport=httpx.MockTransport(handle)))
    assert reader.open_items("g1", "m1", "m2") == body
    [request] = seen
    assert request.url.path == "/groups/g1/open-items"
    assert dict(request.url.params) == {"from": "m1", "to": "m2"}


def lines_ledger(seen: list[httpx.Request], status: int = 200) -> httpx.Client:
    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, json={"items": [], "nextCursor": None})

    return httpx.Client(transport=httpx.MockTransport(handle))


def test_expense_lines_sends_only_set_filters():
    seen: list[httpx.Request] = []
    reader = LedgerReader("http://ledger", "t", lines_ledger(seen))
    assert reader.expense_lines("g1", "2026-11-01", None, None, None, "m2", None) == {"items": [], "nextCursor": None}
    assert seen[0].url.path == "/groups/g1/expense-lines"
    assert dict(seen[0].url.params) == {"from": "2026-11-01", "member": "m2", "limit": "20"}


def test_expense_lines_not_found():
    reader = LedgerReader("http://ledger", "t", lines_ledger([], status=404))
    with pytest.raises(NotFound):
        reader.expense_lines("g1", None, None, None, None, None, None)
