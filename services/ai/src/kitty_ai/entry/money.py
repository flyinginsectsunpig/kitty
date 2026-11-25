"""Turns the model's decimal strings into minor units (integers), exactly. Anything but a plain decimal is refused."""

import re
from decimal import Decimal

from kitty_ai.currencies import exponent

_PLAIN = re.compile(r"^\d+(\.\d+)?$")


def to_minor(amount: str, currency: str) -> int | None:
    """None when the text isn't a plain positive decimal, has more decimals than the currency allows, or the currency
    isn't one Kitty supports."""
    if not _PLAIN.fullmatch(amount or ""):
        return None
    try:
        places = exponent(currency)
    except ValueError:
        return None  # a currency Kitty doesn't support
    _, _, fraction = amount.partition(".")
    if len(fraction) > places:
        return None
    minor = int(Decimal(amount).scaleb(places))
    return minor if minor > 0 else None
