from kitty_ai.mcp.summary import of

NB = " "
ME, SAM, ANA, BOB = "m-me", "m-sam", "m-ana", "m-bob"
MEMBERS = [
    {"id": ME, "displayName": "Zakhir"},
    {"id": SAM, "displayName": "Sam"},
    {"id": ANA, "displayName": "Ana"},
    {"id": BOB, "displayName": "Bob"},
]


def expense(**over) -> dict:
    e = {
        "description": "Dinner",
        "category": "food",
        "currency": "ZAR",
        "amountMinor": 45000,
        "occurredOn": "2026-11-27",
        "payerMemberId": ME,
        "split": "equal",
        "participants": [
            {"memberId": SAM, "name": "Sam", "amountMinor": None},
            {"memberId": ANA, "name": "Ana", "amountMinor": None},
            {"memberId": ME, "name": "me", "amountMinor": None},
        ],
    } | over
    return {"intent": "expense", "groupId": "g", "issues": [], "members": MEMBERS, "expense": e}


def test_expense():
    assert of(expense(), ME, "Flat 4B") == (
        f"Expense in Flat 4B: Dinner, R{NB}450,00, paid by you, split equally between you, Sam and Ana. "
        "Open the link to check and save it."
    )


def test_expense_paid_by_someone_else_by_amounts():
    text = of(expense(payerMemberId=SAM, split="amounts"), ME, "Flat 4B")
    assert "paid by Sam, split by amounts between you, Sam and Ana." in text


def test_payment():
    draft = {
        "intent": "payment",
        "groupId": "g",
        "issues": [],
        "members": MEMBERS,
        "payment": {
            "fromMemberId": ME,
            "toMemberId": BOB,
            "currency": "ZAR",
            "amountMinor": 5000,
            "statedAmountMinor": None,
            "openItems": [{"expenseId": "e-uber", "description": "Uber", "date": "2026-11-18", "openMinor": 5000}],
            "covers": [{"expenseId": "e-uber", "amountMinor": 5000}],
        },
    }
    assert of(draft, ME, "Flat 4B") == (
        f"Payment in Flat 4B: you pay Bob R{NB}50,00 for Uber. Open the link to check and save it."
    )


def test_reminder():
    draft = {
        "intent": "reminder",
        "groupId": "g",
        "issues": [],
        "members": MEMBERS,
        "reminder": {
            "memberId": BOB,
            "name": "Bob",
            "owedMinorByCurrency": {"ZAR": 2000},
            "statedAmountMinor": None,
            "statedCurrency": "ZAR",
        },
    }
    assert of(draft, ME, "Flat 4B") == (
        f"Reminder in Flat 4B: remind Bob to pay you R{NB}20,00. Open the link to check and send it."
    )


def test_issues_are_counted():
    one = expense()
    one["issues"] = [{"field": "people[0]", "kind": "no_match", "text": "Sem", "candidates": []}]
    assert of(one, ME, "Flat 4B").endswith(" Kitty needs you to settle 1 thing on the card.")
    one["issues"] = one["issues"] * 2
    assert of(one, ME, "Flat 4B").endswith(" Kitty needs you to settle 2 things on the card.")
