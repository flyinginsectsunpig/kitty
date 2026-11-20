"""Removes what must never leave our server before receipt text goes to an outside model: card numbers
(full ones that pass the Luhn check, and masked ones), phone numbers, and the names printed after
cashier/waiter/server/operator/card-holder labels. Prices, dates and item names are left alone."""

import re

_CARD = re.compile(r"(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])")
_MASKED_CARD = re.compile(r"(?:[*xX•]{2,}[ -]?){1,4}\d{4}\b")
_PHONE = re.compile(
    r"(?<![\d.,])(?:"
    r"\+\d{1,3}[\s-]?\(?\d{1,4}\)?(?:[\s-]?\d{2,4}){2,3}"  # +27 82 123 4567, +44 20 7946 0958
    r"|\(0\d{1,3}\)[\s-]?\d{3}[\s-]?\d{4}"  # (021) 555-1234
    r"|0\d{2}[\s-]?\d{3}[\s-]?\d{4}"  # 082 123 4567, 0215551234
    r")(?![\d.,])"
)
_NAME_LABEL = re.compile(
    r"(?im)^(\s*(?:cashier|server|waiter|waitress|operator|served by|card ?holder|cardholder)\b\s*[:#-]?\s*)\S.*$"
)


def _luhn(digits: str) -> bool:
    total = 0
    for i, d in enumerate(reversed(digits)):
        n = int(d)
        if i % 2:
            n = n * 2 - 9 if n > 4 else n * 2
        total += n
    return total % 10 == 0


def _card(match: re.Match[str]) -> str:
    digits = re.sub(r"\D", "", match.group())
    return "[card]" if 13 <= len(digits) <= 19 and _luhn(digits) else match.group()


def redact(text: str) -> str:
    text = _CARD.sub(_card, text)
    text = _MASKED_CARD.sub("[card]", text)
    text = _PHONE.sub("[phone]", text)
    return _NAME_LABEL.sub(lambda m: m.group(1) + "[name]", text)
