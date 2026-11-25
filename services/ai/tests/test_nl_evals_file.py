import json
import pathlib

from kitty_ai.entry.schema import ParsedSentence

PHRASES = pathlib.Path(__file__).resolve().parents[1] / "evals" / "nl" / "phrases.jsonl"
EXPECT_FIELDS = {"intent", "amount", "currency", "people", "split", "group", "payer", "category", "reminder_amount"}


def test_nl_evals_file_is_well_formed():
    lines = [json.loads(line) for line in PHRASES.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert len(lines) >= 30
    for case in lines:
        assert set(case) == {"text", "today", "currency", "expect"}, case
        assert set(case["expect"]) <= EXPECT_FIELDS, case
        assert case["expect"]["intent"] in {"expense", "reminder", "unclear"}
        # Every expected value has to be something the model could return.
        ParsedSentence.model_validate({"intent": case["expect"]["intent"]})


def test_the_owners_five_sentences_are_in_the_set():
    texts = {json.loads(line)["text"] for line in PHRASES.read_text(encoding="utf-8").splitlines() if line.strip()}
    assert {
        "add R2000 to expenses under groceries in the family group",
        "petrol R600, split with Sam and Ana",
        "me, John and Joe bought dinner, I had a salad for R50, Joe had a steak for R100 and John had the fish for R70",
        "add R20 debt for Bob",
        "tell Bob he owes me R20",
    } <= texts
