# Evals

Three labelled sets measure Kitty's AI features: receipts, plain-language sentences and Ask Kitty.

## In CI (phase 4e)

`.github/workflows/evals.yml` runs all three nightly (02:17 UTC) and from the "Run workflow" button. It runs only
when the `AI_GEMINI_API_KEY` repository secret is set, and never on pull requests: a run is about 150 calls to the
free tier. Each script writes its scores with `--json-out`. `gate.py` then compares them with `baselines.json`
(the best recorded scores) and writes one summary table to the run:

- **Fail (red):** a metric falls more than max(2 cases, 5 points) below its baseline. That's a real drop, not noise.
- **Warning:** the model was too busy to finish (more than max(2, 10% of cases) skipped), or an eval wrote no
  scores. A warning never turns the run red.
- **Pass:** everything else. A metric with no baseline yet is only reported.

When a score beats its baseline, the summary prints the line to paste into `baselines.json`. Raise a baseline with
a small PR, so the change is reviewed. The scores are also kept as the run's `eval-scores` artifact.

```bash
uv run python evals/gate.py --results DIR --baselines evals/baselines.json   # the same check, locally
```

## Receipts

Measures receipt reading end to end (local OCR → redaction → model → arithmetic check) against labelled
receipts. The target from the design is **≥ 90% total accuracy**.

- `fetch_cord.py`: bootstrap set from CORD-v2 (Indonesian receipts, IDR) until the owner's labelled set of
  ≥ 50 real South African receipts exists. Nothing downloaded is committed.
- `run_receipts.py`: prints `total_accuracy` (printed total read exactly) and `item_f1` (an item counts when
  its line total is equal and its name is ≥ 80% similar). Exits 1 below `--min-total-accuracy`. A receipt the model
  never answered (still busy after 4 tries) is skipped, not scored as wrong.

```bash
cd services/ai
uv run python evals/fetch_cord.py --out .evals/cord --limit 50
AI_GEMINI_API_KEY=... uv run python evals/run_receipts.py --data .evals/cord
```

## Plain-language sentences

`nl/phrases.jsonl` holds 106 labelled sentences (the owner's five scenarios and eight payments among them; 60 were
added in 4e, in South African everyday English, about ten of them deliberately hard);
`nl/run.py` runs the configured model over them and prints intent, amount and people accuracy, plus "other" for every
other labelled field (category, direction, counterpart, items and so on). Runs nightly in CI.

```bash
AI_GEMINI_API_KEY=... uv run python evals/nl/run.py --verbose
```

## Ask Kitty

`ask/questions.jsonl` holds 26 labelled conversations (the owner's four questions, a follow-up, a part payment, a
group the person isn't in, a crossing-off request, an expense whose description tries to give the model orders, and
entries that must go back to `/parse`). `ask/run.py` runs the agent with the configured model against `ask/world.json`,
a fixed fake ledger (Flat 4B, Family, Business trip 2025 and 2026), and prints how often it called the expected
lookups and said (and didn't say) the expected things. Amounts must match the ledger's text exactly. Runs nightly
in CI.

```bash
AI_GEMINI_API_KEY=... uv run python evals/ask/run.py --verbose
```

## Results

Since 4e, every nightly run's scores are in its summary and its `eval-scores` artifact. `baselines.json` keeps the
best ones. The tables below are the runs recorded by hand before that, plus the first CI run.

Receipts, on 50 CORD-v2 receipts:

| Date | Model | Total accuracy | Item F1 |
|---|---|---|---|
| 2026-11-24 | gemini-3.5-flash-lite | 78% | 0.780 |
| 2026-11-25 | gemini-3.5-flash-lite | 82% | 0.763 |
| 2026-11-26 | gemini-3.5-flash-lite | 80% | 0.767 |
| 2026-11-27 (first 4e run) | gemini-3.5-flash-lite | 80% | 0.783 |

Plain-language sentences, run by hand by the owner. Record each run here:

| Date | Model | Intent | Amount | People | Other |
|---|---|---|---|---|---|
| 2026-11-26 | gemini-3.5-flash-lite | 46/46 | 23/23 | 20/24 | 68/73 |
| 2026-11-27 (106 sentences, first 4e run) | gemini-3.5-flash-lite | 106/106 | 47/48 | 34/49 | 130/140 |

On the 106-sentence set, people is low because **for reminders the model leaves `people` empty**. That holds for all
11 reminder sentences, so a typed reminder doesn't name its person on the card. It's a product bug, tracked
separately; fixing it should raise this baseline.

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

Phase 4c changed this set, so later runs aren't comparable with the three above:
- Crossing off is now an entry again. Case 6 expects `not_a_question`, and the app turns the sentence into a payment
  card.
- The world has one linked payment: R 25,00 of the R 50,00 payment to Joe covers the Uber. So "how much do I owe Joe"
  lists only the groceries (case 2 now expects no "Uber").
- `/me/owing` lists only what's still open, and each payment has its part not tied to an item.

The plain-language set gained eight payment sentences (intent `payment`).

Ask Kitty on the Phase 4c set:

| Date | Model | Calls | Contains | Not contains | Entry | Model calls |
|---|---|---|---|---|---|---|
| 2026-11-26 | gemini-3.5-flash-lite | 20/20 | 35/35 | 8/8 | 26/26 | 58 over 26 |
| 2026-11-27 (first 4e run) | gemini-3.5-flash-lite | 20/20 | 35/35 | 8/8 | 26/26 | – |
