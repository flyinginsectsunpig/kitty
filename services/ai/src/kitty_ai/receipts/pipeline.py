"""Photo → text (on this machine) → redacted text → model → checked receipt. RateLimited is left to the caller,
which retries later; every other problem becomes a failure reason the ledger shows to the host."""

import logging

from kitty_ai.contracts.kitty.events.v1 import receipts_pb2 as pb
from kitty_ai.receipts import validate
from kitty_ai.receipts.extract import Extractor, ModelUnavailable, UnusableOutput
from kitty_ai.receipts.ocr import Ocr
from kitty_ai.receipts.redact import redact

Reason = pb.ScanFailure.Reason
log = logging.getLogger(__name__)


def process(image: bytes, ocr: Ocr, extractor: Extractor, currency: str) -> pb.ParsedReceipt | int:
    text = ocr.read(image)
    if not text.strip():
        return Reason.UNREADABLE
    try:
        receipt = extractor.extract(redact(text))
    except ModelUnavailable as e:
        # The model's own words (a rejected key, an unknown model): the host only sees "switched off". Never the key.
        log.warning("Receipt model unavailable: %s", e)
        return Reason.MODEL_UNAVAILABLE
    except UnusableOutput:
        return Reason.UNREADABLE
    return validate.to_parsed(receipt, currency)
