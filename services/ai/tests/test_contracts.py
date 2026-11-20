import os
import pathlib

from google.protobuf.timestamp_pb2 import Timestamp

from kitty_ai.contracts.kitty.events.v1 import receipts_pb2 as pb

FIXTURE = pathlib.Path(__file__).resolve().parents[3] / "contracts" / "fixtures" / "receipt_result_parsed.bin"


def golden_result() -> pb.ReceiptResult:
    return pb.ReceiptResult(
        event_id="0d3f6f2e-6a51-4c39-9a0e-9d1c4d8e2b10",
        occurred_at=Timestamp(seconds=1795046400),
        scan_id="7b0c2a9e-1f4d-4c8a-b6e3-2d5f8a9c0e11",
        session_id="c83939f5-2e2e-44b1-aa19-16707cb82a78",
        parsed=pb.ParsedReceipt(
            merchant="Mzansi Grill",
            receipt_date="2026-11-20",
            currency="ZAR",
            items=[
                pb.ParsedItem(description="Burger", quantity=1, line_total_minor=12000),
                pb.ParsedItem(description="Coke", quantity=2, line_total_minor=5000),
            ],
            charges=[pb.ParsedCharge(kind="tip", amount_minor=1700)],
            total_minor=18700,
        ),
    )


def test_golden_parsed_result():
    data = golden_result().SerializeToString(deterministic=True)
    if os.environ.get("KITTY_UPDATE_FIXTURES") == "1":
        FIXTURE.write_bytes(data)
    assert FIXTURE.read_bytes() == data
