"""Runs the configured model (Gemini or Ollama) over evals/nl/phrases.jsonl and reports how often it gets the
intent, the amount and the people right. Not run in CI (free-tier limits); run by hand and record the result in
evals/README.md.

Usage (from services/ai, with AI_GEMINI_API_KEY or AI_OLLAMA_URL set):
  uv run python evals/nl/run.py [--delay 4] [--verbose]
"""

import argparse
import json
import pathlib
import sys
import time
from datetime import date

from kitty_ai.entry.parse import parser_from
from kitty_ai.receipts.extract import RateLimited
from kitty_ai.settings import Settings

PHRASES = pathlib.Path(__file__).with_name("phrases.jsonl")


def _people(parsed) -> list[str]:
    return sorted(p.name.casefold() for p in parsed.people)


def main() -> int:
    args = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    args.add_argument("--delay", type=float, default=4.0, help="seconds between calls (free tier: 15 a minute)")
    args.add_argument("--verbose", action="store_true")
    opts = args.parse_args()

    parser = parser_from(Settings())
    cases = [json.loads(line) for line in PHRASES.read_text(encoding="utf-8").splitlines() if line.strip()]
    scores = {"intent": [0, 0], "amount": [0, 0], "people": [0, 0], "other": [0, 0]}
    for case in cases:
        for attempt in range(3):
            try:
                got = parser.parse(case["text"], date.fromisoformat(case["today"]), case["currency"])
                break
            except RateLimited:
                time.sleep(20 * (attempt + 1))
        else:
            print(f"gave up (rate limited): {case['text']}", file=sys.stderr)
            continue
        expect = case["expect"]
        for key, want in expect.items():
            bucket = key if key in scores else "other"
            have = _people(got) if key == "people" else getattr(got, key)
            if key == "items":
                have = sorted(n.casefold() for n in have)
            if key in ("people", "items"):
                right = sorted(n.casefold() for n in want) == have
            elif isinstance(want, str) and isinstance(have, str):
                right = have.casefold() == want.casefold()
            else:
                right = have == want
            scores[bucket][0] += right
            scores[bucket][1] += 1
            if opts.verbose and not right:
                print(f"  {key}: want {want!r}, got {have!r}  ← {case['text']}")
        time.sleep(opts.delay)

    for name, (right, total) in scores.items():
        if total:
            print(f"{name}_accuracy {right / total:.2f} ({right}/{total})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
