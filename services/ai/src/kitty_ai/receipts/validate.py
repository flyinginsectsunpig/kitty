"""Turns what the model read into the event the ledger gets, in minor units of the bill's currency, and
rejects it unless items plus charges come to the printed total (within 1%). In South Africa VAT is already
in the prices, so tax is added as a charge only when that is what makes the receipt add up."""

import re
from decimal import Decimal, InvalidOperation

from kitty_ai.contracts.kitty.events.v1 import receipts_pb2 as pb
from kitty_ai.currencies import exponent
from kitty_ai.receipts.schema import ExtractedReceipt

Reason = pb.ScanFailure.Reason


def parse_amount(text: str | None, exp: int) -> int | None:
    """A printed amount ("1 234,50", "R 120,00", "1,234.50") in minor units, or None if it isn't one."""
    if text is None:
        return None
    s = re.sub(r"[^\d.,-]", "", text)
    if not s or s.startswith("-") or not any(c.isdigit() for c in s):
        return None
    last_sep = max(s.rfind(","), s.rfind("."))
    if last_sep >= 0 and 1 <= len(s) - last_sep - 1 <= 2 and exp > 0:
        whole, frac = s[:last_sep], s[last_sep + 1 :]
    else:
        whole, frac = s, ""
    whole = re.sub(r"[.,]", "", whole)
    try:
        value = Decimal(f"{whole or 0}.{frac or 0}")
    except InvalidOperation:
        return None
    return int(value.scaleb(exp).to_integral_value())


def _agrees(subtotal: int, total: int) -> bool:
    return abs(subtotal - total) * 100 <= total


def to_parsed(receipt: ExtractedReceipt, currency: str) -> pb.ParsedReceipt | int:
    """The parsed receipt in the bill's currency, or a ScanFailure.Reason."""
    exp = exponent(currency)
    items = []
    for item in receipt.items:
        amount = parse_amount(item.line_total, exp)
        if amount is None or not item.description.strip():
            continue
        items.append(
            pb.ParsedItem(description=item.description.strip(), quantity=max(1, item.quantity), line_total_minor=amount)
        )
    if not items:
        return Reason.NO_ITEMS

    charges = [
        pb.ParsedCharge(kind=kind, amount_minor=amount)
        for kind, raw in (("tip", receipt.tip), ("service", receipt.service_charge), ("delivery", receipt.delivery))
        if (amount := parse_amount(raw, exp))
    ]
    total = parse_amount(receipt.total, exp)
    if total is None:
        return Reason.TOTALS_MISMATCH

    subtotal = sum(i.line_total_minor for i in items) + sum(c.amount_minor for c in charges)
    if not _agrees(subtotal, total):
        tax = parse_amount(receipt.tax, exp)
        if not tax or not _agrees(subtotal + tax, total):
            return Reason.TOTALS_MISMATCH
        charges.append(pb.ParsedCharge(kind="other", amount_minor=tax))

    return pb.ParsedReceipt(
        merchant=receipt.merchant.strip(),
        receipt_date=receipt.date if re.fullmatch(r"\d{4}-\d{2}-\d{2}", receipt.date or "") else "",
        currency=currency,
        items=items,
        charges=charges,
        total_minor=total,
    )
