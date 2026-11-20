# Receipt evals

Measures receipt reading end to end (local OCR → redaction → model → arithmetic check) against labelled
receipts. The target from the design is **≥ 90% total accuracy**.

- `fetch_cord.py`: bootstrap set from CORD-v2 (Indonesian receipts, IDR) until the owner's labelled set of
  ≥ 50 real South African receipts exists. Nothing downloaded is committed.
- `run_receipts.py`: prints `total_accuracy` (printed total read exactly) and `item_f1` (an item counts when
  its line total is equal and its name is ≥ 80% similar). Exits 1 below `--min-total-accuracy`.
- CI: `.github/workflows/evals.yml` runs nightly and on demand, only when the `AI_GEMINI_API_KEY` repository
  secret is set. Free-tier limits are tight, so it paces calls and never runs on pull requests.

```bash
cd services/ai
uv run python evals/fetch_cord.py --out .evals/cord --limit 50
AI_GEMINI_API_KEY=... uv run python evals/run_receipts.py --data .evals/cord
```

## Results

No run recorded yet: it needs a Gemini API key (or a local Ollama), which this repository doesn't have.
Record each run here: date, model, data set, receipts, total accuracy, item F1.
