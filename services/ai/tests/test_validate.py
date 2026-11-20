from kitty_ai.contracts.kitty.events.v1 import receipts_pb2 as pb
from kitty_ai.receipts.schema import ExtractedItem, ExtractedReceipt
from kitty_ai.receipts.validate import parse_amount, to_parsed

Reason = pb.ScanFailure.Reason


def receipt(items, total, **charges) -> ExtractedReceipt:
    return ExtractedReceipt(
        merchant="Mzansi Grill",
        date="2026-11-20",
        items=[ExtractedItem(description=d, quantity=q, line_total=t) for d, q, t in items],
        total=total,
        **charges,
    )


def test_totals_within_one_percent_pass():
    result = to_parsed(receipt([("Burger", 1, "120.00"), ("Coke", 2, "50.00")], "187.00", tip="17.00"), "ZAR")
    assert isinstance(result, pb.ParsedReceipt)
    assert [(i.description, i.quantity, i.line_total_minor) for i in result.items] == [
        ("Burger", 1, 12000),
        ("Coke", 2, 5000),
    ]
    assert [(c.kind, c.amount_minor) for c in result.charges] == [("tip", 1700)]
    assert (result.total_minor, result.currency, result.merchant, result.receipt_date) == (
        18700,
        "ZAR",
        "Mzansi Grill",
        "2026-11-20",
    )


def test_rounding_within_one_percent_still_passes():
    assert isinstance(to_parsed(receipt([("Burger", 1, "120.00")], "121.00"), "ZAR"), pb.ParsedReceipt)


def test_off_by_more_than_one_percent_fails():
    assert to_parsed(receipt([("Burger", 1, "120.00")], "150.00"), "ZAR") == Reason.TOTALS_MISMATCH


def test_vat_inclusive_tax_is_not_added():
    result = to_parsed(receipt([("Burger", 1, "100.00")], "100.00", tax="13.04"), "ZAR")
    assert isinstance(result, pb.ParsedReceipt)
    assert list(result.charges) == []


def test_additive_tax_becomes_other_charge():
    result = to_parsed(receipt([("Burger", 1, "100.00")], "108.00", tax="8.00"), "USD")
    assert [(c.kind, c.amount_minor) for c in result.charges] == [("other", 800)]


def test_service_and_delivery_charges():
    result = to_parsed(receipt([("Pizza", 1, "200.00")], "250.00", service_charge="20.00", delivery="30.00"), "ZAR")
    assert [(c.kind, c.amount_minor) for c in result.charges] == [("service", 2000), ("delivery", 3000)]


def test_no_items_fails():
    assert to_parsed(receipt([], "0.00"), "ZAR") == Reason.NO_ITEMS


def test_unreadable_total_fails():
    assert to_parsed(receipt([("Burger", 1, "120.00")], "see slip"), "ZAR") == Reason.TOTALS_MISMATCH


def test_quantity_below_one_counts_as_one():
    result = to_parsed(receipt([("Burger", 0, "120.00")], "120.00"), "ZAR")
    assert result.items[0].quantity == 1


def test_zero_decimal_currency():
    result = to_parsed(receipt([("Ramen", 1, "1,200")], "1,200"), "JPY")
    assert result.items[0].line_total_minor == 1200


def test_comma_decimal_prices():
    assert parse_amount("1 234,50", 2) == 123450
    assert parse_amount("R 120,00", 2) == 12000
    assert parse_amount("1,234.50", 2) == 123450
    assert parse_amount("1.234,50", 2) == 123450
    assert parse_amount("120", 2) == 12000
    assert parse_amount("-5.00", 2) is None
    assert parse_amount("abc", 2) is None
