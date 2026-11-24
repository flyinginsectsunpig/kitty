"""Runs receipt reading (the real OCR, redaction and model) over a folder of labelled receipts and reports
total accuracy and line-item F1. Exits 1 when total accuracy is below --min-total-accuracy.

Folder layout: NAME.jpg (or .png/.webp) next to NAME.json, e.g.
  {"currency": "ZAR", "total_minor": 12000,
   "items": [{"description": "Burger", "quantity": 1, "line_total_minor": 12000}]}

Usage (from services/ai, with AI_GEMINI_API_KEY or AI_OLLAMA_URL set):
  uv run python evals/run_receipts.py --data DIR [--limit N] [--min-total-accuracy 0.9] [--delay 4]
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

IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png", ".webp")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=pathlib.Path, required=True)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--min-total-accuracy", type=float, default=0.9)
    parser.add_argument("--delay", type=float, default=4.0, help="seconds between model calls (free-tier pacing)")
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
        for attempt in range(4):
            try:
                outcome = process(image.read_bytes(), ocr, extractor, raw.get("currency", "ZAR"))
                break
            except RateLimited:
                time.sleep(30 * (attempt + 1))
        else:
            outcome = pb.ScanFailure.Reason.RATE_LIMITED  # still rate limited: counts as a failed read
        pairs.append((label, outcome))
        print(f"{path.stem}: {describe_outcome(outcome)}")
        time.sleep(args.delay)

    scores = score(pairs)
    print(f"receipts={scores.receipts} total_accuracy={scores.total_accuracy:.3f} item_f1={scores.item_f1:.3f}")
    return 0 if scores.total_accuracy >= args.min_total_accuracy else 1


if __name__ == "__main__":
    sys.exit(main())
