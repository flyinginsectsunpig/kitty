import json
import pathlib

import pytest

from kitty_ai.money_text import money_text


def _fixture() -> list[dict]:
    for parent in pathlib.Path(__file__).resolve().parents:
        path = parent / "contracts" / "fixtures" / "money-format.json"
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    raise FileNotFoundError("contracts/fixtures/money-format.json")


@pytest.mark.parametrize("case", _fixture(), ids=lambda c: f"{c['minor']}-{c['currency']}")
def test_money_text_matches_fixture(case):
    assert money_text(case["minor"], case["currency"]) == case["expected"]
