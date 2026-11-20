"""Minor-unit exponents, from the same contracts/currencies.json the ledger and web use."""

import json
import os
import pathlib
from functools import cache


def _find() -> pathlib.Path:
    if configured := os.environ.get("KITTY_CURRENCIES"):
        return pathlib.Path(configured)
    for parent in pathlib.Path(__file__).resolve().parents:
        candidate = parent / "contracts" / "currencies.json"
        if candidate.exists():
            return candidate
    raise FileNotFoundError("contracts/currencies.json not found; set KITTY_CURRENCIES")


@cache
def exponents() -> dict[str, int]:
    return json.loads(_find().read_text(encoding="utf-8"))


def exponent(currency: str) -> int:
    try:
        return exponents()[currency]
    except KeyError:
        raise ValueError(f"Unsupported currency {currency!r}") from None
