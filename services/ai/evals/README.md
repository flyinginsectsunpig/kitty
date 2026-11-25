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

## Plain-language sentences

`nl/phrases.jsonl` holds 37 labelled sentences (the owner's five scenarios among them); `nl/run.py` runs the
configured model over them and prints intent, amount and people accuracy. Not in CI.

```bash
AI_GEMINI_API_KEY=... uv run python evals/nl/run.py --verbose
```

## Ask Kitty

`ask/questions.jsonl` holds 26 labelled conversations (the owner's four questions, a follow-up, a part payment, a
group the person isn't in, a crossing-off request, an expense whose description tries to give the model orders, and
entries that must go back to `/parse`). `ask/run.py` runs the agent with the configured model against `ask/world.json`,
a fixed fake ledger (Flat 4B, Family, Business trip 2025 and 2026), and prints how often it called the expected
lookups and said (and didn't say) the expected things. Amounts must match the ledger's text exactly. Not in CI.

```bash
AI_GEMINI_API_KEY=... uv run python evals/ask/run.py --verbose
```

## Results

No run recorded yet: it needs a Gemini API key (or a local Ollama), which this repository doesn't have.
Record each run here: date, model, data set, receipts, total accuracy, item F1.

Plain-language sentences: not run yet (2026-11-25): no Gemini key or Ollama on the development machine. Record each
run here: date, model, intent / amount / people accuracy.

Ask Kitty, run by hand by the owner. Record each run here:

| Date | Model | Calls | Contains | Not contains | Entry | Model calls |
|---|---|---|---|---|---|---|
| 2026-11-25 | gemini-3.5-flash-lite | 17/19 | 35/37 | 9/9 | 25/26 | 57 over 26 |
| 2026-11-25 | gemini-3.5-flash-lite | 19/19 | 36/37 | 9/9 | 25/26 | 57 over 26 |
| 2026-11-25 | gemini-3.5-flash-lite | 19/19 | 37/37 | 9/9 | 26/26 | 57 over 26 |

Between the runs:
- `not_a_question` now counts as a lookup.
- The groceries case no longer requires an item name.
- Crossing off is ruled out of `not_a_question`, first in the prompt and then in the tool's own description. The
  second run shows the prompt alone wasn't enough.
