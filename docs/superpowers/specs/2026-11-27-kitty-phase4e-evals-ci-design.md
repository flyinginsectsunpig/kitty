# Kitty Phase 4e: Evals in CI

Status: draft for approval · 2026-11-27 · Parent: `2026-11-15-kitty-design.md` (§5.1 Evals, phase 4)

## 1. Intent

Kitty's AI features (reading receipts, reading sentences, Ask Kitty) can get quietly worse. Gemini can change under the same name, a prompt edit can backfire, or a library can be upgraded. 4e runs all three evals automatically, nightly and on demand. It shows every score in one place and goes red only when quality has really dropped. It also shows evals in CI, which is one of the skills Kitty exists to demonstrate.

Today:
- Only receipts run nightly (`.github/workflows/evals.yml`, 50 Indonesian CORD receipts). That run fails every night, because it reads about 80% of totals exactly against a fixed 90% target, so the red mark carries no news.
- Sentences (46 phrases) and Ask Kitty (26 conversations) run only by hand, and their results are typed into `services/ai/evals/README.md`.

## 2. Agreed

- **Red means worse than the best recorded score, not below the design's target.** Each eval has a committed baseline. A run fails only when a score drops clearly below it. A real improvement raises the baseline through a small PR.
- **"Clearly below" allows for noise.** A score fails when it falls more than `max(2 cases, 5 points)` under its baseline. For example, receipts (50, each 2%) fail only below baseline − 5 points.
- **A busy model isn't a failure.** When Gemini is overloaded and an eval can't finish, the run shows a warning, not a red mark.
- **One nightly job runs all three evals, plus a "Run workflow" button.** That's about 150 Gemini calls a night, within the free tier's 500 a day. Evals never run on pull requests.
- **One summary table per run** on GitHub: each score, its baseline, the design target, and pass, warning or fail. GitHub emails the owner when a nightly run fails.
- **The sentence set grows to about 100.** Roughly 55 new labelled phrases in South African everyday English, a few of them deliberately hard. The owner skims them before they count.
- **Receipts stay on CORD for now,** with a ready slot for the owner's 50 real South African receipts.

## 3. Goals, non-goals, anti-goals

**Goals**
- The three eval scripts write their scores as JSON as well as their current text.
- A gate script compares the scores with `services/ai/evals/baselines.json`, writes the summary, and passes, warns or fails.
- One workflow runs receipts, sentences and Ask Kitty in turn, then the gate.
- About 100 labelled sentences.

**Non-goals**
- Running evals on pull requests.
- A hosted eval service or dashboard.
- New eval types (for example the MCP tools, which are deterministic and covered by unit tests).
- Collecting the real South African receipts (that's the owner's job).

**Anti-goals**
- A job that is red every night for a known, unchanged weakness.
- Turning red because Gemini was busy.
- The API key appearing anywhere in logs or the summary.

## 4. Approaches (decided: A)

- **A. Kitty's own small gate (chosen).** The scripts write JSON, a short Python gate compares it with committed baselines and writes the summary, and one workflow runs everything. No new dependencies, and the existing evals stay as they are.
- B. An eval framework (promptfoo, DeepEval and similar). It brings dashboards, but also new dependencies, often a hosted service, and a rewrite of all three evals. That's heavy for three small sets, and a hosted dashboard is at odds with "free and self-hosted".
- C. Three workflows, each with its own threshold. Simplest to write, but it gives three reports instead of one and copies the baseline logic three times.

## 5. Design

### 5.1 Scores as JSON

Each runner gains `--json-out PATH` and writes:

```json
{"eval": "nl", "model": "gemini-3.5-flash-lite", "cases": 101, "skipped": 0,
 "metrics": {"intent": {"right": 101, "total": 101}, "amount": {...}, "people": {...}, "other": {...}}}
```

- `skipped` counts cases the script gave up on because the model stayed busy after its retries. Those cases are left out of the metrics, as they are today.
- **Receipts:** `total_accuracy` (exact totals) and `item_f1`. F1 is a fraction rather than right/total, so for receipts the "cases" are the receipts scored.
- **Sentences:** `intent`, `amount`, `people`, `other`.
- **Ask Kitty:** `calls`, `contains`, `not_contains`, `entry`, plus `model_calls` reported for information only.

The text output stays the same, so the README's hand runs still work.

### 5.2 Baselines and the gate

`services/ai/evals/baselines.json` holds, per eval and metric, the best recorded value and the case count it was measured over:

- **Seeded from the recorded runs:**
  - receipts: total accuracy 0.82, item F1 0.78, over 50 receipts (best of the nightly runs above);
  - Ask Kitty on the Phase 4c set: 20/20, 35/35, 8/8, 26/26.
- **Sentences** need a fresh run once the set has grown, since the 46-phrase numbers don't carry over. Until a baseline exists, the gate reports the scores and says "no baseline yet", without failing.
- **Design targets** are shown beside each eval for reference (receipts: total accuracy 0.90).

`evals/gate.py` reads the JSON files and the baselines and decides per eval:

- **warning (incomplete):** when `skipped > max(2, 10% of cases)`, or the script didn't produce a file because the model was unavailable;
- **fail:** when any metric is below `baseline − max(2 / total, 0.05)`;
- **pass:** otherwise.

It writes a Markdown table to `$GITHUB_STEP_SUMMARY` (or stdout locally), emits a `::warning::` for each warning, and exits 1 only on a fail. When a run beats a baseline, the summary says so and shows the line to put in `baselines.json`.

### 5.3 Workflow

`.github/workflows/evals.yml` becomes one job:

1. Skip without `AI_GEMINI_API_KEY`, as today.
2. List the models the key can use, as today.
3. Run receipts, then sentences, then Ask Kitty, each with `--json-out`. A script that fails because the model is unavailable doesn't stop the others: each step runs with `continue-on-error`, and the gate decides.
4. Run the gate.

It runs nightly (the existing 02:17 UTC slot) and from the "Run workflow" button, which keeps the `limit` and `model` inputs. The scores' JSON files are uploaded as an artifact.

### 5.4 More sentences

About 55 new lines in `evals/nl/phrases.jsonl`, written to the existing format. They cover:
- expenses with equal and uneven splits;
- debts;
- reminders, payments and crossing off;
- questions;
- unclear sentences.

The voice is South African: rands and "R", Uber, taxis, braais, groceries, petrol, rent, "split with my brother", "me and the guys". About ten are deliberately hard: two amounts, a relative date, someone else paid, a name that looks like a word. The owner skims them in the PR before the baseline is recorded.

## 6. Constraints

- Free tier only: about 150 calls a night, with the existing delays between calls.
- No new dependencies.
- The key stays a repository secret and is never printed.
- Evals never run on pull requests.

## 7. Left to the builder

- The gate's table layout and exact wording.
- How each runner counts `skipped`, using its existing "gave up" paths.
- Whether the JSON is written by one shared helper.
- The exact wording of the new sentences, within §5.4.
