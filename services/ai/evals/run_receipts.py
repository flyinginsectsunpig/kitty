"""Runs receipt reading (the real OCR, redaction and model) over a folder of labelled receipts and reports
total accuracy and line-item F1. Exits 1 when total accuracy is below --min-total-accuracy.

Folder layout: NAME.jpg (or .png/.webp) next to NAME.json, e.g.
  {"currency": "ZAR", "total_minor": 12000,
   "items": [{"description": "Burger", "quantity": 1, "line_total_minor": 12000}]}

Usage (from services/ai, with AI_GEMINI_API_KEY or AI_OLLAMA_URL set):
  uv run python evals/run_receipts.py --data DIR [--limit N] [--min-total-accuracy 0.9] [--delay 4] [--json-out F]

A receipt the model never answered (still busy after 4 tries) is skipped, not scored as a wrong read.
"""

import argparse
import json
import pathlib
import sys
import time

from kitty_ai.contracts.kitty.events.v1 import receipts_pb2 as pb
from kitty_ai.receipts.extract import RateLimited, extractor_from
from kitty_ai.receipts.ocr import RapidOcr
from kitty_ai.receipts.pipeline import process
from kitty_ai.receipts.scoring import ReceiptLabel, describe_outcome, score
from kitty_ai.settings import Settings

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from results import Metric, model_name, write_results  # noqa: E402  (evals/ is a folder of scripts, not a package)

IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png", ".webp")


def collect(outcomes: list[tuple[ReceiptLabel, pb.ParsedReceipt | int]]) -> tuple[list, int]:
    """The pairs to score, and how many receipts the model never answered (left out of the score)."""
    pairs = [(label, o) for label, o in outcomes if o != pb.ScanFailure.Reason.RATE_LIMITED]
    return pairs, len(outcomes) - len(pairs)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=pathlib.Path, required=True)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--min-total-accuracy", type=float, default=0.9)
    parser.add_argument("--delay", type=float, default=4.0, help="seconds between model calls (free-tier pacing)")
    parser.add_argument("--json-out", type=pathlib.Path, help="also write the scores here, for evals/gate.py")
    args = parser.parse_args()

    labels = sorted(args.data.glob("*.json"))[: args.limit or None]
    if not labels:
        print(f"No labelled receipts in {args.data}", file=sys.stderr)
        return 2

    ocr, extractor = RapidOcr(), extractor_from(Settings())
    pairs = []
    for path in labels:
        image = next((path.with_suffix(s) for s in IMAGE_SUFFIXES if path.with_suffix(s).exists()), None)
        if image is None:
            print(f"skip {path.name}: no image", file=sys.stderr)
            continue
        raw = json.loads(path.read_text(encoding="utf-8"))
        label = ReceiptLabel(
            items=[(i["description"], i["line_total_minor"]) for i in raw["items"]], total_minor=raw["total_minor"]
        )
        started = time.monotonic()
        for attempt in range(4):
            try:
                outcome = process(image.read_bytes(), ocr, extractor, raw.get("currency", "ZAR"))
                break
            except RateLimited as e:
                wait = 30 * (attempt + 1)
                # Timeouts land here too: say which, so a slow model isn't mistaken for a throttled one.
                print(f"{path.stem}: busy or slow ({str(e)[:120]}); retrying in {wait}s", file=sys.stderr, flush=True)
                time.sleep(wait)
        else:
            outcome = pb.ScanFailure.Reason.RATE_LIMITED  # still rate limited: counts as a failed read
        pairs.append((label, outcome))
        # flush: CI pipes stdout, which Python would otherwise hold back until the run ends.
        print(f"{path.stem}: {describe_outcome(outcome)} in {time.monotonic() - started:.1f}s", flush=True)
        time.sleep(args.delay)

    pairs, skipped = collect(pairs)
    scores = score(pairs)
    print(f"receipts={scores.receipts} total_accuracy={scores.total_accuracy:.3f} item_f1={scores.item_f1:.3f}")
    if skipped:
        print(f"skipped={skipped} (the model never answered)")
    if args.json_out:
        metrics = {"total_accuracy": Metric(scores.total_accuracy, scores.receipts),
                   "item_f1": Metric(scores.item_f1, scores.receipts)}  # fmt: skip
        write_results(args.json_out, "receipts", model_name(), scores.receipts + skipped, skipped, metrics)
    return 0 if scores.total_accuracy >= args.min_total_accuracy else 1


if __name__ == "__main__":
    sys.exit(main())
