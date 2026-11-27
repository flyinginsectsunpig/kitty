import importlib.util
import json
import pathlib

from kitty_ai.contracts.kitty.events.v1 import receipts_pb2 as pb
from kitty_ai.receipts.scoring import ReceiptLabel

EVALS = pathlib.Path(__file__).resolve().parents[1] / "evals"


def load(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


results = load("eval_results", EVALS / "results.py")


def test_write_results_shape(tmp_path):
    out = tmp_path / "nl.json"
    results.write_results(out, "nl", "gemini-3.5-flash-lite", cases=46, skipped=0,
                          metrics={"intent": results.ratio(45, 46)})  # fmt: skip
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data == {
        "eval": "nl",
        "model": "gemini-3.5-flash-lite",
        "cases": 46,
        "skipped": 0,
        "metrics": {"intent": {"value": 0.9783, "total": 46}},
    }


def test_extra_top_level_fields_are_kept(tmp_path):
    out = tmp_path / "ask.json"
    results.write_results(out, "ask", "m", cases=26, skipped=1, metrics={}, extra={"model_calls": 58})
    assert json.loads(out.read_text(encoding="utf-8"))["model_calls"] == 58


def test_ratio_of_nothing():
    assert results.ratio(0, 0) == results.Metric(0.0, 0)


def test_receipt_rate_limited_counts_as_skipped():
    receipts = load("run_receipts", EVALS / "run_receipts.py")
    label = ReceiptLabel(items=[("Burger", 12000)], total_minor=12000)
    ok = pb.ParsedReceipt(items=[pb.ParsedItem(description="Burger", quantity=1, line_total_minor=12000)],
                          total_minor=12000)  # fmt: skip
    pairs, skipped = receipts.collect([(label, ok), (label, pb.ScanFailure.Reason.RATE_LIMITED), (label, ok)])
    assert len(pairs) == 2
    assert skipped == 1
