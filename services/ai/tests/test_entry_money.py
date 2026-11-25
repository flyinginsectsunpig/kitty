import pytest

from kitty_ai.entry.money import to_minor


@pytest.mark.parametrize(
    ("amount", "currency", "minor"),
    [("2000", "ZAR", 200000), ("20.5", "ZAR", 2050), ("0.99", "EUR", 99), ("500", "JPY", 500)],
)
def test_plain_decimals_convert_exactly(amount, currency, minor):
    assert to_minor(amount, currency) == minor


@pytest.mark.parametrize("amount", ["2 000", "1 500,50", "2,000", "R200", "-5", "1e3", "", "0", "0.00"])
def test_converter_rejects_grouped_or_comma_numbers(amount):
    assert to_minor(amount, "ZAR") is None


def test_more_decimals_than_the_currency_has_is_rejected():
    assert to_minor("1.234", "ZAR") is None
    assert to_minor("5.5", "JPY") is None


def test_an_unsupported_currency_gives_no_amount():
    assert to_minor("20", "XYZ") is None
