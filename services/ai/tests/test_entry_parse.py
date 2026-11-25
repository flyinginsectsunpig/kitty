from datetime import date
from types import SimpleNamespace

import pytest
from google.genai import errors

from kitty_ai.entry import parse
from kitty_ai.entry.parse import GeminiParser, NoModel, parser_from
from kitty_ai.entry.schema import ParsedSentence
from kitty_ai.receipts.extract import ModelUnavailable, RateLimited, UnusableOutput
from kitty_ai.settings import Settings

PARSED = {
    "intent": "expense",
    "group": None,
    "description": "Dinner",
    "category": "food",
    "currency": None,
    "amount": "450",
    "date": None,
    "payer": "me",
    "people": [{"name": "me", "amount": None}, {"name": "Sam", "amount": None}, {"name": "Lee", "amount": None}],
    "split": "equal",
    "reminder_amount": None,
}


class FakeModels:
    def __init__(self, result=None, error=None):
        self.result, self.error, self.calls = result, error, []

    def generate_content(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.result


def gemini(models):
    return GeminiParser(model="gemini-test", client=SimpleNamespace(models=models))


def test_gemini_parser_sends_only_the_sentence_date_and_currency():
    models = FakeModels(SimpleNamespace(parsed=ParsedSentence.model_validate(PARSED), text=None))
    got = gemini(models).parse("dinner R450 with Sam and Lee, I paid", date(2026, 11, 25), "ZAR")

    assert got.amount == "450" and [p.name for p in got.people] == ["me", "Sam", "Lee"]
    [call] = models.calls
    assert (
        call["contents"] == "Today: 2026-11-25\nDefault currency: ZAR\nSentence: dinner R450 with Sam and Lee, I paid"
    )
    assert call["config"].response_schema is ParsedSentence
    assert call["config"].temperature == 0


def test_no_default_currency_when_the_group_is_unknown():
    models = FakeModels(SimpleNamespace(parsed=ParsedSentence.model_validate(PARSED), text=None))
    gemini(models).parse("lunch 30", date(2026, 11, 25), None)
    assert "Default currency: none" in models.calls[0]["contents"]


def test_schema_rejects_an_unknown_category():
    bad = dict(PARSED, category="snacks")
    models = FakeModels(SimpleNamespace(parsed=None, text=__import__("json").dumps(bad)))
    with pytest.raises(UnusableOutput):
        gemini(models).parse("snacks R20", date(2026, 11, 25), "ZAR")


def test_throttled_is_rate_limited():
    models = FakeModels(error=errors.APIError(429, {"error": {"message": "slow down"}}))
    with pytest.raises(RateLimited):
        gemini(models).parse("x", date(2026, 11, 25), "ZAR")


def test_no_model_raises_unavailable():
    with pytest.raises(ModelUnavailable):
        NoModel().parse("x", date(2026, 11, 25), "ZAR")
    assert isinstance(parser_from(Settings(gemini_api_key="", ollama_url="")), NoModel)


def test_payment_fields_validate():
    parsed = ParsedSentence.model_validate(
        {"intent": "payment", "direction": "i_paid", "counterpart": "Joe", "items": ["Uber"]}
    )
    assert (parsed.direction, parsed.counterpart, parsed.items) == ("i_paid", "Joe", ["Uber"])


def test_prompt_describes_payments():
    assert "cross off the Uber for Joe, I paid him" in parse.SYSTEM
