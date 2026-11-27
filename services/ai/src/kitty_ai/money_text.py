"""Money as the apps show it, for sentences the ai service writes itself (MCP draft summaries): "R 1 234,56",
"£20,00", "-R 5,00". The same rules as the ledger's MoneyText, pinned by contracts/fixtures/money-format.json."""

from kitty_ai.currencies import exponent

NBSP = " "
# en-ZA's currency prefixes, as the ledger has them; a trailing no-break space where Intl puts one.
PREFIXES = {
    "AUD": "A$", "BRL": "R$", "CAD": "CA$", "CNY": "CN¥", "EUR": "€", "GBP": "£", "HKD": "HK$", "ILS": "₪",
    "INR": "₹", "JPY": "JP¥", "KRW": "₩", "MXN": "MX$", "NZD": "NZ$", "PHP": "₱", "USD": "US$", "ZAR": f"R{NBSP}",
}  # fmt: skip


def money_text(minor: int, currency: str) -> str:
    exp = exponent(currency)
    prefix = PREFIXES.get(currency, f"{currency}{NBSP}")
    digits = str(abs(minor)).rjust(exp + 1, "0")
    whole, fraction = (digits[:-exp], digits[-exp:]) if exp else (digits, "")
    grouped = ""
    for i, ch in enumerate(whole):
        if i > 0 and (len(whole) - i) % 3 == 0:
            grouped += NBSP
        grouped += ch
    number = f"{grouped},{fraction}" if exp else grouped
    return f"{'-' if minor < 0 else ''}{prefix}{number}"
