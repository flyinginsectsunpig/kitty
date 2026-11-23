from kitty_ai.receipts.redact import redact


def test_card_numbers_are_redacted():
    assert redact("VISA 4111 1111 1111 1111 APPROVED") == "VISA [card] APPROVED"
    assert redact("4111-1111-1111-1111") == "[card]"
    assert redact("Card 4111111111111111") == "Card [card]"


def test_card_followed_by_an_amount_or_expiry_on_the_same_line():
    # OCR joins a printed line into one string, so other numbers often sit right after the card number.
    assert redact("VISA 4111 1111 1111 1111 187,00") == "VISA [card] 187,00"
    assert redact("Card 4111 1111 1111 1111 12/27") == "Card [card] 12/27"
    assert redact("REF 9 4111111111111111 00") == "REF 9 [card] 00"


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


def test_names_after_labels_mid_line():
    assert redact("Table 12 Waiter: Sipho Covers 4") == "Table 12 Waiter: [name]"
    assert redact("Tbl 5   Server: Thandi M") == "Tbl 5   Server: [name]"
    assert redact("Tbl 5   Server: Thandi   Covers 4") == "Tbl 5   Server: [name]   Covers 4"


def test_customer_names_are_redacted():
    assert redact("Customer: Amina") == "Customer: [name]"
    assert redact("Name: Amina Dlamini") == "Name: [name]"
    assert redact("Order 42   Client: J Smith") == "Order 42   Client: [name]"
    assert redact("Guest name - Thabo") == "Guest name - [name]"


def test_name_words_without_a_label_separator_are_left_alone():
    assert redact("Name brand coffee 30,00") == "Name brand coffee 30,00"


def test_label_words_inside_item_names_are_left_alone():
    assert redact("Chef's special waiter tip jar 10,00") == "Chef's special waiter tip jar 10,00"


def test_prices_and_dates_survive():
    text = "2 x Coke 50,00\n1 Burger 120.00\nDate 2026-11-20 19:42\nTOTAL R 170,00\nVAT 15% 22,17"
    assert redact(text) == text


def test_whole_receipt():
    text = "Mzansi Grill\nTel 011 555 0199\nWaiter: Sipho\n1 Burger 120,00\nVISA ****1111\nTOTAL 120,00"
    assert redact(text) == "Mzansi Grill\nTel [phone]\nWaiter: [name]\n1 Burger 120,00\nVISA [card]\nTOTAL 120,00"
