"""Removes what must never leave our server before receipt text goes to an outside model: card numbers
(full ones that pass the Luhn check, and masked ones), phone numbers, and the names printed after
cashier/waiter/server/operator/card-holder labels. Prices, dates and item names are left alone."""

import re

# Runs of digit groups joined by single spaces or dashes; a card number is any stretch of whole groups inside
# a run that has 13-19 digits and passes Luhn (OCR puts amounts and expiry dates on the same line).
_DIGIT_RUN = re.compile(r"(?<![\d-])\d+(?:[ -]\d+)*(?![\d-])")
_GROUP = re.compile(r"\d+")
_MASKED_CARD = re.compile(r"(?:[*xX•]{2,}[ -]?){1,4}\d{4}\b")
_PHONE = re.compile(
    r"(?<![\d.,])(?:"
    r"\+\d{1,3}[\s-]?\(?\d{1,4}\)?(?:[\s-]?\d{2,4}){2,3}"  # +27 82 123 4567, +44 20 7946 0958
    r"|\(0\d{1,3}\)[\s-]?\d{3}[\s-]?\d{4}"  # (021) 555-1234
    r"|0\d{2}[\s-]?\d{3}[\s-]?\d{4}"  # 082 123 4567, 0215551234
    r")(?![\d.,])"
)
_LABELS = r"cashier|server|waiter|waitress|operator|served by|card ?holder|cardholder"
# At the start of a line the separator is optional ("Waiter Sipho"); mid-line it must be there ("Tbl 5 Waiter: Sipho").
# The name runs to the next wide gap (a printed column) or the end of the line.
_NAME_AT_START = re.compile(rf"(?im)^(\s*(?:{_LABELS})\b\s*[:#-]?\s*)\S.*?(?=\s{{2,}}|$)")
_NAME_MID_LINE = re.compile(rf"(?im)(\b(?:{_LABELS})\s*[:#]\s*)\S.*?(?=\s{{2,}}|$)")
# The person paying or ordering. These words also start ordinary item names ("Name brand coffee"), so they
# always need a separator after them.
_CUSTOMER_LABELS = r"customer(?: name)?|client|guest(?: name)?|name|order for|cardholder name"
_CUSTOMER = re.compile(rf"(?im)(\b(?:{_CUSTOMER_LABELS})\s*[:#-]\s*)\S.*?(?=\s{{2,}}|$)")


def _luhn(digits: str) -> bool:
    total = 0
    for i, d in enumerate(reversed(digits)):
        n = int(d)
        if i % 2:
            n = n * 2 - 9 if n > 4 else n * 2
        total += n
    return total % 10 == 0


def _cards_in_run(match: re.Match[str]) -> str:
    run = match.group()
    groups = list(_GROUP.finditer(run))
    spans: list[tuple[int, int]] = []
    i = 0
    while i < len(groups):
        found = None
        digits = ""
        for j in range(i, len(groups)):
            digits += groups[j].group()
            if len(digits) > 19:
                break
            if len(digits) >= 13 and _luhn(digits):
                # The shortest valid stretch: a valid card stays valid with "00" appended, and that "00" is
                # usually the cents of an amount printed after it.
                found = j
                break
        if found is None:
            i += 1
            continue
        spans.append((groups[i].start(), groups[found].end()))
        i = found + 1
    for start, end in reversed(spans):
        run = run[:start] + "[card]" + run[end:]
    return run


def redact(text: str) -> str:
    text = _DIGIT_RUN.sub(_cards_in_run, text)
    text = _MASKED_CARD.sub("[card]", text)
    text = _PHONE.sub("[phone]", text)
    text = _NAME_AT_START.sub(lambda m: m.group(1) + "[name]", text)
    text = _NAME_MID_LINE.sub(lambda m: m.group(1) + "[name]", text)
    return _CUSTOMER.sub(lambda m: m.group(1) + "[name]", text)
