from kitty_ai.receipts.redact import redact


def test_card_numbers_are_redacted():
    assert redact("VISA 4111 1111 1111 1111 APPROVED") == "VISA [card] APPROVED"
    assert redact("4111-1111-1111-1111") == "[card]"
    assert redact("Card 4111111111111111") == "Card [card]"


def test_number_that_fails_luhn_is_kept():
    # A barcode or reference number, not a card.
    assert redact("Ref 4111111111111112") == "Ref 4111111111111112"


def test_masked_cards():
    assert redact("Card: **** 1234") == "Card: [card]"
    assert redact("XXXX1234") == "[card]"
    assert redact("************5678 CHIP") == "[card] CHIP"


def test_sa_phone_numbers():
    assert redact("Tel +27 82 123 4567") == "Tel [phone]"
    assert redact("Call 082 123 4567") == "Call [phone]"
    assert redact("(021) 555-1234") == "[phone]"
    assert redact("0215551234") == "[phone]"


def test_names_after_labels():
    assert redact("Cashier: Thandi M") == "Cashier: [name]"
    assert redact("Waiter - Sipho") == "Waiter - [name]"
    assert redact("SERVER: Ana-Marie") == "SERVER: [name]"
    assert redact("Operator: 0042 Lerato") == "Operator: [name]"
    assert redact("Card holder: J SMITH") == "Card holder: [name]"


def test_prices_and_dates_survive():
    text = "2 x Coke 50,00\n1 Burger 120.00\nDate 2026-11-20 19:42\nTOTAL R 170,00\nVAT 15% 22,17"
    assert redact(text) == text


def test_whole_receipt():
    text = "Mzansi Grill\nTel 011 555 0199\nWaiter: Sipho\n1 Burger 120,00\nVISA ****1111\nTOTAL 120,00"
    assert redact(text) == "Mzansi Grill\nTel [phone]\nWaiter: [name]\n1 Burger 120,00\nVISA [card]\nTOTAL 120,00"
