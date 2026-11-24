from kitty_ai.contracts.kitty.events.v1 import receipts_pb2 as pb
from kitty_ai.receipts.extract import ModelUnavailable, UnusableOutput
from kitty_ai.receipts.pipeline import process
from kitty_ai.receipts.schema import ExtractedItem, ExtractedReceipt

Reason = pb.ScanFailure.Reason
BURGER = ExtractedReceipt(items=[ExtractedItem(description="Burger", line_total="120,00")], total="120,00")


class FakeOcr:
    def __init__(self, text: str):
        self.text = text

    def read(self, image: bytes) -> str:
        return self.text


class FakeExtractor:
    def __init__(self, result=BURGER, error: Exception | None = None):
        self.result, self.error, self.seen = result, error, []

    def extract(self, text: str) -> ExtractedReceipt:
        self.seen.append(text)
        if self.error:
            raise self.error
        return self.result


def test_parsed_receipt_in_the_bills_currency():
    result = process(b"jpeg", FakeOcr("Burger 120,00\nTOTAL 120,00"), FakeExtractor(), "ZAR")
    assert isinstance(result, pb.ParsedReceipt)
    assert (result.items[0].line_total_minor, result.currency) == (12000, "ZAR")


def test_extractor_never_sees_card_or_phone():
    extractor = FakeExtractor()
    text = "Mzansi Grill\nTel 082 123 4567\nBurger 120,00\nVISA 4111 1111 1111 1111\nTOTAL 120,00"
    process(b"jpeg", FakeOcr(text), extractor, "ZAR")
    sent = extractor.seen[0]
    assert "4111" not in sent
    assert "082 123 4567" not in sent
    assert "Burger 120,00" in sent


def test_blank_photo_is_unreadable_and_never_reaches_the_model():
    extractor = FakeExtractor()
    assert process(b"jpeg", FakeOcr("   "), extractor, "ZAR") == Reason.UNREADABLE
    assert extractor.seen == []


def test_no_model_is_model_unavailable():
    assert process(b"x", FakeOcr("Burger"), FakeExtractor(error=ModelUnavailable()), "ZAR") == Reason.MODEL_UNAVAILABLE


def test_nonsense_answer_is_unreadable():
    assert process(b"x", FakeOcr("Burger"), FakeExtractor(error=UnusableOutput()), "ZAR") == Reason.UNREADABLE


def test_why_the_model_was_unavailable_is_logged(caplog):
    error = ModelUnavailable("400 INVALID_ARGUMENT. API key not valid.")
    with caplog.at_level("WARNING"):
        assert process(b"x", FakeOcr("Burger"), FakeExtractor(error=error), "ZAR") == Reason.MODEL_UNAVAILABLE
    assert "API key not valid" in caplog.text
