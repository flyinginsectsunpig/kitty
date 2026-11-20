"""Downloads receipts from the CORD-v2 test split (Indonesian receipts, prices in IDR) and writes them in the
folder layout run_receipts.py reads. Uses Hugging Face's public dataset rows API; nothing is committed.

Usage (from services/ai):  uv run python evals/fetch_cord.py --out DIR [--limit 50]
"""

import argparse
import json
import pathlib

import httpx

from kitty_ai.currencies import exponent
from kitty_ai.receipts.validate import parse_amount

ROWS = "https://datasets-server.huggingface.co/rows"
DATASET = "naver-clova-ix/cord-v2"
CURRENCY = "IDR"


def to_label(ground_truth: str) -> dict | None:
    """CORD's annotation as a run_receipts label, or None when it has no usable items or total."""
    gt = json.loads(ground_truth)["gt_parse"]
    menu = gt.get("menu", [])
    menu = menu if isinstance(menu, list) else [menu]
    exp = exponent(CURRENCY)
    items = []
    for line in menu:
        minor = parse_amount(line.get("price") if isinstance(line.get("price"), str) else None, exp)
        if minor is None or not isinstance(line.get("nm"), str):
            continue
        count = line.get("cnt")
        quantity = int(count) if isinstance(count, str) and count.strip().isdigit() else 1
        items.append({"description": line["nm"], "quantity": quantity, "line_total_minor": minor})
    total_raw = (gt.get("total") or {}).get("total_price")
    total = parse_amount(total_raw if isinstance(total_raw, str) else None, exp)
    if not items or total is None:
        return None
    return {"currency": CURRENCY, "items": items, "total_minor": total}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    parser.add_argument("--limit", type=int, default=50)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    written, offset = 0, 0
    with httpx.Client(timeout=60) as http:
        while written < args.limit:
            page = http.get(
                ROWS, params={"dataset": DATASET, "config": "default", "split": "test", "offset": offset, "length": 20}
            )
            page.raise_for_status()
            rows = page.json()["rows"]
            if not rows:
                break
            for row in rows:
                offset += 1
                label = to_label(row["row"]["ground_truth"])
                if label is None or written >= args.limit:
                    continue
                name = f"cord-{row['row_idx']:04d}"
                image = http.get(row["row"]["image"]["src"])
                image.raise_for_status()
                (args.out / f"{name}.jpg").write_bytes(image.content)
                (args.out / f"{name}.json").write_text(json.dumps(label, ensure_ascii=False), encoding="utf-8")
                written += 1
    print(f"wrote {written} receipts to {args.out}")


if __name__ == "__main__":
    main()
