from datetime import date

from kitty_ai.entry.resolve import build_draft, match_group, match_member
from kitty_ai.entry.schema import ParsedSentence
from kitty_ai.ledger import Group, GroupSummary, Member

TODAY = date(2026, 11, 25)
ME = Member("m-me", "Zakhir McKinnon", "u-me")
SAM = Member("m-sam", "Sam Naidoo", "u-sam")
SAMIR = Member("m-samir", "Samir", "u-samir")
ANA = Member("m-ana", "Ana", None)  # a placeholder
JOE = Member("m-joe", "Joe", "u-joe")
JOHN = Member("m-john", "John", "u-john")
BOB = Member("m-bob", "Bob", "u-bob")
FLAT = Group("g-flat", "Flat 4B", "ZAR", [ME, SAM, ANA, JOE, JOHN, BOB])
FAMILY = GroupSummary("g-family", "Family", "ZAR")
RENT = GroupSummary("g-rent", "Rent house", "ZAR")
FLAT_S = GroupSummary("g-flat", "Flat 4B", "ZAR")


def parsed(**kw) -> ParsedSentence:
    return ParsedSentence.model_validate({"intent": "expense", **kw})


def no_open_items(from_member: str, to_member: str) -> dict:
    raise AssertionError("open_items is only asked for payments")


def draft(p: ParsedSentence, group=FLAT, owed=None, open_items=no_open_items):
    return build_draft(p, group, ME.id, TODAY, (lambda member_id: owed or {}), open_items)


def issues(d) -> list[tuple[str, str]]:
    return [(i["field"], i["kind"]) for i in d["issues"]]


# Names


def test_exact_then_first_name_then_prefix():
    assert match_member("Sam Naidoo", ME.id, FLAT.members).member_id == SAM.id
    assert match_member("sam", ME.id, FLAT.members).member_id == SAM.id  # first name
    assert match_member("Jo", ME.id, [ME, JOE]).member_id == JOE.id  # prefix


def test_two_sams_is_ambiguous_with_both_candidates():
    m = match_member("Sam", ME.id, [ME, Member("m-s1", "Sam Naidoo", None), Member("m-s2", "Sam Botha", None)])
    assert (m.kind, sorted(m.candidates)) == ("ambiguous", ["m-s1", "m-s2"])


def test_unknown_name_is_no_match():
    m = match_member("Thabo", ME.id, FLAT.members)
    assert (m.kind, m.member_id) == ("no_match", None)


def test_me_and_i_are_the_speaker():
    for word in ("me", "I", "my", "Me"):
        assert match_member(word, ME.id, FLAT.members).member_id == ME.id


def test_placeholders_match():
    assert match_member("ana", ME.id, FLAT.members).member_id == ANA.id


# Groups


def test_group_phrase_beats_page_group():
    m = match_group("family group", "g-flat", [FAMILY, RENT, FLAT_S])
    assert (m.group_id, m.issue) == ("g-family", None)
    assert match_group("the rent house", None, [FAMILY, RENT, FLAT_S]).group_id == "g-rent"


def test_no_phrase_uses_page_group_else_single_group_else_issue():
    assert match_group(None, "g-flat", [FAMILY, FLAT_S]).group_id == "g-flat"
    assert match_group(None, None, [FAMILY]).group_id == "g-family"
    m = match_group(None, None, [FAMILY, FLAT_S])
    assert (m.group_id, m.issue["kind"]) == (None, "missing")


def test_unknown_group_phrase_is_flagged_with_the_groups():
    m = match_group("work", "g-flat", [FAMILY, FLAT_S])
    assert (m.group_id, m.issue["kind"]) == (None, "no_match")


# Expenses


def test_no_people_means_everyone():
    d = draft(parsed(amount="2000", category="groceries", group="family"))
    assert [p["memberId"] for p in d["expense"]["participants"]] == [m.id for m in FLAT.members]
    assert d["expense"]["split"] == "equal" and d["expense"]["category"] == "groceries"


def test_no_payer_means_me():
    d = draft(parsed(amount="600", people=[{"name": "me"}, {"name": "Sam"}, {"name": "Ana"}]))
    assert d["expense"]["payerMemberId"] == ME.id
    assert d["expense"]["amountMinor"] == 60000 and d["expense"]["currency"] == "ZAR"
    assert issues(d) == []


def test_equal_split_with_one_name_includes_the_speaker():
    d = draft(parsed(amount="85", description="Uber", people=[{"name": "Sam"}], split="equal"))
    assert [p["memberId"] for p in d["expense"]["participants"]] == [SAM.id, ME.id]


def test_issue_fields_point_at_the_named_rows_after_the_speaker_is_added():
    # "Uber R85 with Sa": the speaker is added, and the issue must still name the row "Sa" is on.
    group = Group("g-x", "X", "ZAR", [ME, SAM, SAMIR])
    d = draft(parsed(amount="85", description="Uber", people=[{"name": "Sa"}], split="equal"), group=group)
    participants = d["expense"]["participants"]
    assert ME.id in [p["memberId"] for p in participants]
    for issue in d["issues"]:
        index = int(issue["field"][len("people[") : -1])
        assert participants[index]["name"] == issue["text"] == "Sa"


def test_one_person_without_an_explicit_split_owes_the_whole_amount():
    # "Lee owes me R150" read without a split: Bob owes it all; the speaker isn't added to halve it.
    d = draft(parsed(amount="150", description="Concert", people=[{"name": "Bob"}]))
    assert [p["memberId"] for p in d["expense"]["participants"]] == [BOB.id]


def test_a_date_the_model_wrote_badly_is_flagged():
    d = draft(parsed(amount="10", date="last friday"))
    assert ("date", "missing") in issues(d) and d["expense"]["occurredOn"] == "2026-11-25"


def test_currency_case_is_ignored_and_an_unsupported_one_is_flagged():
    assert draft(parsed(amount="30", currency="eur"))["expense"]["currency"] == "EUR"
    d = draft(parsed(amount="30", currency="XYZ"))
    assert ("currency", "missing") in issues(d)
    assert d["expense"]["currency"] == "ZAR"  # the group's, so the form can still open


def test_amounts_split_totals_the_people():
    d = draft(
        parsed(
            description="Dinner",
            people=[{"name": "me", "amount": "50"}, {"name": "Joe", "amount": "100"}, {"name": "John", "amount": "70"}],
            split="amounts",
        )
    )
    e = d["expense"]
    assert (e["split"], e["amountMinor"], e["payerMemberId"]) == ("amounts", 22000, ME.id)
    assert [(p["memberId"], p["amountMinor"]) for p in e["participants"]] == [
        (ME.id, 5000),
        (JOE.id, 10000),
        (JOHN.id, 7000),
    ]


def test_total_and_amounts_disagree_is_mismatch():
    d = draft(
        parsed(amount="300", people=[{"name": "me", "amount": "50"}, {"name": "Joe", "amount": "100"}], split="amounts")
    )
    assert ("amount", "mismatch") in issues(d)


def test_foreign_currency_is_kept():
    d = draft(parsed(amount="30", currency="EUR", description="Lunch"))
    assert (d["expense"]["currency"], d["expense"]["amountMinor"]) == ("EUR", 3000)


def test_debt_for_bob_is_one_participant_paid_by_me():
    d = draft(parsed(description="Debt", people=[{"name": "Bob", "amount": "20"}], split="amounts"))
    e = d["expense"]
    assert (e["payerMemberId"], e["amountMinor"]) == (ME.id, 2000)
    assert [(p["memberId"], p["amountMinor"]) for p in e["participants"]] == [(BOB.id, 2000)]


def test_unmatched_names_are_kept_and_flagged():
    d = draft(parsed(amount="90", people=[{"name": "me"}, {"name": "Thabo"}]))
    assert ("people[1]", "no_match") in issues(d)
    assert d["expense"]["participants"][1] == {"memberId": None, "name": "Thabo", "amountMinor": None}


def test_an_unreadable_amount_is_missing():
    d = draft(parsed(amount="2 000", description="Rent"))
    assert d["expense"]["amountMinor"] is None and ("amount", "missing") in issues(d)


def test_draft_lists_the_groups_members():
    assert draft(parsed(amount="10"))["members"][0] == {"id": ME.id, "displayName": "Zakhir McKinnon"}


# Reminders


def test_reminder_draft_carries_owed_and_stated():
    d = draft(parsed(intent="reminder", people=[{"name": "Bob"}], reminder_amount="20"), owed={"ZAR": 15000})
    r = d["reminder"]
    assert (r["memberId"], r["owedMinorByCurrency"], r["statedAmountMinor"], r["statedCurrency"]) == (
        BOB.id,
        {"ZAR": 15000},
        2000,
        "ZAR",
    )


def test_a_reminder_without_a_person_is_missing():
    d = draft(parsed(intent="reminder"))
    assert ("reminder.member", "missing") in issues(d)


def test_question_is_passed_through():
    d = draft(parsed(intent="question", amount="20", people=[{"name": "Sam"}]))
    assert d == {"intent": "question", "groupId": "g-flat", "issues": [], "members": []}


# Payments


def owed_item(expense_id: str, description: str, day: str, minor: int, currency: str = "ZAR") -> dict:
    item = {
        "expenseId": expense_id,
        "description": description,
        "date": day,
        "category": "other",
        "total": {"currency": currency, "minor": minor * 2, "text": ""},
        "myShare": {"currency": currency, "minor": minor, "text": ""},
        "paidBy": "Joe",
    }
    return {"item": item, "open": {"currency": currency, "minor": minor, "text": ""}}


UBER = owed_item("e-uber", "Uber", "2026-11-18", 2500)
GROCERIES = owed_item("e-groceries", "Groceries", "2026-11-20", 9500)


class FakeOpenItems:
    """The ledger's open items from one member to another, newest first like the ledger lists them."""

    def __init__(self, *items: dict):
        self.items, self.calls = items, []

    def __call__(self, from_member: str, to_member: str) -> dict:
        self.calls.append((from_member, to_member))
        by_currency: dict[str, list[dict]] = {}
        for i in sorted(self.items, key=lambda i: i["item"]["date"], reverse=True):
            by_currency.setdefault(i["open"]["currency"], []).append(i)
        currencies = [
            {
                "currency": c,
                "fromOwes": owes,
                "fromOwesTotal": {"currency": c, "minor": sum(i["open"]["minor"] for i in owes), "text": ""},
                "toOwes": [],
                "toOwesTotal": {"currency": c, "minor": 0, "text": ""},
            }
            for c, owes in by_currency.items()
        ]
        return {"fromMemberId": from_member, "toMemberId": to_member, "currencies": currencies}


def payment(open_items=None, **kw) -> dict:
    p = parsed(intent="payment", counterpart="Joe", **kw)
    return draft(p, open_items=open_items or FakeOpenItems(UBER, GROCERIES))


def test_payment_covers_the_named_item():
    d = payment(direction="i_paid", items=["Uber"])
    pay = d["payment"]
    assert (pay["fromMemberId"], pay["toMemberId"], pay["currency"]) == (ME.id, JOE.id, "ZAR")
    assert pay["covers"] == [{"expenseId": "e-uber", "amountMinor": 2500}]
    assert (pay["amountMinor"], pay["statedAmountMinor"]) == (2500, None)
    assert pay["openItems"] == [
        {"expenseId": "e-uber", "description": "Uber", "date": "2026-11-18", "openMinor": 2500},
        {"expenseId": "e-groceries", "description": "Groceries", "date": "2026-11-20", "openMinor": 9500},
    ]
    assert d["intent"] == "payment" and issues(d) == []


def test_payment_part_amount_stays_on_one_item():
    pay = payment(direction="i_paid", items=["uber"], amount="10")["payment"]
    assert pay["covers"] == [{"expenseId": "e-uber", "amountMinor": 1000}]
    assert (pay["amountMinor"], pay["statedAmountMinor"]) == (1000, 1000)


def test_payment_without_items_covers_everything_open():
    pay = payment(direction="i_paid")["payment"]
    assert pay["covers"] == [
        {"expenseId": "e-uber", "amountMinor": 2500},
        {"expenseId": "e-groceries", "amountMinor": 9500},
    ]
    assert pay["amountMinor"] == 12000


def test_a_stated_amount_is_allocated_oldest_first_and_the_rest_stays_untied():
    pay = payment(direction="i_paid", amount="150")["payment"]
    assert pay["covers"] == [
        {"expenseId": "e-uber", "amountMinor": 2500},
        {"expenseId": "e-groceries", "amountMinor": 9500},
    ]
    assert pay["amountMinor"] == 15000
    pay = payment(direction="i_paid", amount="30")["payment"]
    assert pay["covers"] == [
        {"expenseId": "e-uber", "amountMinor": 2500},
        {"expenseId": "e-groceries", "amountMinor": 500},
    ]


def test_two_matches_is_an_ambiguous_issue():
    second = owed_item("e-uber-2", "Uber home", "2026-11-19", 4000)
    d = payment(FakeOpenItems(UBER, second, GROCERIES), direction="i_paid", items=["Uber"])
    issue = next(i for i in d["issues"] if i["field"] == "payment.items[0]")
    assert (issue["kind"], sorted(issue["candidates"])) == ("ambiguous", ["e-uber", "e-uber-2"])
    assert d["payment"]["covers"] == []


def test_an_unknown_item_is_no_match_with_every_open_item():
    d = payment(direction="i_paid", items=["Uber", "petrol"])
    issue = next(i for i in d["issues"] if i["field"] == "payment.items[1]")
    assert (issue["kind"], issue["text"], issue["candidates"]) == ("no_match", "petrol", ["e-uber", "e-groceries"])
    assert d["payment"]["covers"] == [{"expenseId": "e-uber", "amountMinor": 2500}]


def test_a_phrase_matches_by_word_prefixes():
    pay = payment(FakeOpenItems(owed_item("e-w", "Woolworths groceries", "2026-11-21", 300)), items=["groc wool"])
    assert pay["payment"]["covers"] == [{"expenseId": "e-w", "amountMinor": 300}]


def test_payment_with_nothing_open_is_an_issue():
    d = payment(FakeOpenItems(), direction="i_paid", items=["Uber"])
    assert issues(d) == [("payment.items", "missing")]
    assert (d["payment"]["covers"], d["payment"]["openItems"]) == ([], [])


def test_they_paid_reverses_the_members():
    open_items = FakeOpenItems(UBER, GROCERIES)
    pay = payment(open_items, direction="they_paid")["payment"]
    assert (pay["fromMemberId"], pay["toMemberId"]) == (JOE.id, ME.id)
    assert open_items.calls == [(JOE.id, ME.id)]


def test_no_direction_means_i_paid():
    open_items = FakeOpenItems(UBER)
    pay = payment(open_items, items=["Uber"])["payment"]
    assert (pay["fromMemberId"], pay["toMemberId"]) == (ME.id, JOE.id)
    assert open_items.calls == [(ME.id, JOE.id)]


def test_other_currency_item_is_flagged():
    hotel = owed_item("e-hotel", "Hotel", "2026-11-10", 12000, "EUR")
    d = payment(FakeOpenItems(UBER, hotel), direction="i_paid", items=["hotel"])
    assert issues(d) == [("payment.items[0]", "other_currency")]
    assert [i["expenseId"] for i in d["payment"]["openItems"]] == ["e-uber"]  # only the group's currency is listed
    assert d["payment"]["covers"] == []


def test_a_sentence_in_another_currency_is_flagged():
    d = payment(direction="i_paid", items=["Uber"], amount="10", currency="EUR")
    assert ("payment.amount", "other_currency") in issues(d)
    assert d["payment"]["currency"] == "ZAR"


def test_a_missing_or_unknown_counterpart_is_an_issue_and_the_ledger_isnt_asked():
    d = draft(parsed(intent="payment", direction="i_paid", items=["Uber"]))  # no_open_items raises if called
    assert issues(d) == [("payment.counterpart", "missing")]
    pay = d["payment"]
    assert (pay["fromMemberId"], pay["toMemberId"], pay["openItems"], pay["covers"]) == (ME.id, None, [], [])
    assert issues(draft(parsed(intent="payment", counterpart="Thabo"))) == [("payment.counterpart", "no_match")]
    assert issues(draft(parsed(intent="payment", counterpart="me"))) == [("payment.counterpart", "no_match")]
    d = draft(parsed(intent="payment", direction="they_paid", counterpart="Jo"))
    issue = d["issues"][0]
    assert (issue["field"], issue["kind"], sorted(issue["candidates"])) == (
        "payment.counterpart",
        "ambiguous",
        [JOE.id, JOHN.id],
    )
    assert (d["payment"]["fromMemberId"], d["payment"]["toMemberId"]) == (None, ME.id)


def test_unreadable_amount_is_an_issue():
    d = payment(direction="i_paid", amount="2 000")
    issue = next(i for i in d["issues"] if i["field"] == "payment.amount")
    assert (issue["kind"], issue["text"]) == ("missing", "2 000")
    assert (d["payment"]["amountMinor"], d["payment"]["statedAmountMinor"]) == (None, None)


def test_payment_draft_lists_the_groups_members():
    assert payment(items=["Uber"])["members"][0] == {"id": ME.id, "displayName": "Zakhir McKinnon"}
