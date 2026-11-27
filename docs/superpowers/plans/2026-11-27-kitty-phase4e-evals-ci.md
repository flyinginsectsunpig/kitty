# Kitty Phase 4e: Evals in CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One nightly/on-demand workflow runs the receipt, sentence and Ask Kitty evals, and a gate compares their scores with committed baselines. The run goes red only on a clear drop, warns when the model was too busy to finish, and writes one summary table.

**Architecture:**
- Each runner gains `--json-out`, written through a shared helper (`evals/results.py`).
- `evals/gate.py` reads those files and `evals/baselines.json`, writes Markdown to `$GITHUB_STEP_SUMMARY`, and exits 1 only on a fail.
- `.github/workflows/evals.yml` runs the three evals in turn, then the gate.

**Tech Stack:** Python 3.13 (uv), pytest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-27-kitty-phase4e-evals-ci-design.md`

## Global Constraints

- No new dependencies. Free tier only: about 150 model calls a night, keeping the existing delays.
- Evals never run on pull requests. The key stays a secret and is never printed.
- **Fail rule:** a metric fails when it is below `baseline − max(2 / total, 0.05)`, where `total` is this run's count for that metric.
- **Warning rule:** an eval warns, never fails, when `skipped > max(2, 0.10 × cases)`, or when its JSON file is missing.
- **No baseline:** a metric with no baseline is reported as "no baseline yet" and never fails.
- **Seeded baselines:**
  - receipts: `total_accuracy` 0.82 and `item_f1` 0.78, over 50;
  - Ask Kitty: `calls` 20/20, `contains` 35/35, `not_contains` 8/8, `entry` 26/26.
  - Sentences have none until a run on the grown set.
- **Design target shown:** receipts `total_accuracy` 0.90.
- Conventional commits; no attribution lines.

## Review Focus

1. **A runner crashes before writing JSON** (bad key, import error). The gate shows that eval as a warning ("no results"), and the others still report. → Task 2 `test_missing_file_is_a_warning`.
2. **A metric has total 0** (no cases of that kind scored). Expect it skipped in the table, with no division by zero. → Task 2 `test_empty_metric_is_ignored`.
3. **A receipt the model never answered.** It counts as skipped, not as a wrong read. Today it scores as wrong. → Task 1 `test_receipt_rate_limited_counts_as_skipped`.
4. **Both a regression and a skipped-heavy run.** The warning wins, since a busy model makes the scores unreliable. → Task 2 `test_incomplete_run_warns_even_if_scores_drop`.
5. **No summary file locally.** Without `GITHUB_STEP_SUMMARY`, the table goes to stdout. → Task 2 `test_prints_table_without_step_summary`.

---

### Task 1: Scores as JSON

**Files:**
- Create: `services/ai/evals/results.py`
- Modify: `services/ai/evals/run_receipts.py`, `services/ai/evals/nl/run.py`, `services/ai/evals/ask/run.py`
- Test: `services/ai/tests/test_eval_results.py`

**Interfaces:**
- Produces, in `evals/results.py`:
  - `Metric(value: float, total: int)`, a frozen dataclass.
  - `write_results(path: Path, eval_name: str, model: str, cases: int, skipped: int, metrics: dict[str, Metric]) -> None`. It writes `{"eval", "model", "cases", "skipped", "metrics": {name: {"value", "total"}}}` with values rounded to 4 places.
  - `ratio(right: int, total: int) -> Metric`.
- Each runner accepts `--json-out PATH`. It still prints exactly the text it prints today.
  - Receipts: `eval="receipts"`, metrics `total_accuracy` and `item_f1`, totals = receipts scored.
  - Sentences: `eval="nl"`, metrics `intent`, `amount`, `people`, `other`.
  - Ask Kitty: `eval="ask"`, metrics `calls`, `contains`, `not_contains`, `entry`, plus a top-level `"model_calls"`.
  - `model` is `Settings().gemini_model` when a Gemini key is set, otherwise `"ollama:" + ollama_model`.
- **Receipts change:** a receipt still rate-limited after its 4 tries is counted in `skipped` and left out of `score()`. Today it counts as a wrong read.
- **`skipped`** for sentences and Ask Kitty is the count of today's "gave up (rate limited)" paths.

- [ ] **Step 1: Write the failing tests**
  - `test_write_results_shape`: write the file with `{"intent": ratio(45, 46)}`, read it back, and check `metrics.intent == {"value": 0.9783, "total": 46}` and `skipped == 0`.
  - `test_ratio_of_nothing`: `ratio(0, 0) == Metric(0.0, 0)`.
  - `test_receipt_rate_limited_counts_as_skipped`: extract the receipt loop's bookkeeping into `run_receipts.collect(outcomes) -> tuple[list[pairs], int]`. With outcomes `[ok, RATE_LIMITED, ok]` it returns 2 pairs and `skipped == 1`.

- [ ] **Step 2: Run them to verify they fail**
  - Run: `cd services/ai && uv run pytest tests/test_eval_results.py -q`
  - Expected: FAIL (`ModuleNotFoundError: evals.results`). The tests import evals as a package: add `evals/__init__.py` if it's missing, and put `services/ai` on `sys.path` as `tests/test_evals.py` already does.

- [ ] **Step 3: Implement** the helper, the three `--json-out` flags and `collect`.

- [ ] **Step 4: Run the tests to verify they pass**
  - Run: `cd services/ai && uv run pytest -q -m "not slow" && uv run ruff check . && uv run ruff format --check .`
  - Expected: all pass.

- [ ] **Step 5: Commit:** `feat(ai): eval scripts write their scores as JSON`

---

### Task 2: The gate and the baselines

**Files:**
- Create: `services/ai/evals/gate.py`, `services/ai/evals/baselines.json`
- Test: `services/ai/tests/test_eval_gate.py`

**Interfaces:**
- Consumes: the JSON shape from Task 1.
- Produces:
  - `baselines.json`:

    ```json
    {
      "receipts": {"target": {"total_accuracy": 0.9},
                   "metrics": {"total_accuracy": {"value": 0.82, "total": 50}, "item_f1": {"value": 0.78, "total": 50}}},
      "nl": {"metrics": {}},
      "ask": {"metrics": {"calls": {"value": 1.0, "total": 20}, "contains": {"value": 1.0, "total": 35},
                          "not_contains": {"value": 1.0, "total": 8}, "entry": {"value": 1.0, "total": 26}}}
    }
    ```

  - `judge(result: dict | None, baseline: dict) -> Verdict`, with `Verdict(status: Literal["pass", "warn", "fail"], rows: list[Row], notes: list[str])` and `Row(metric, value, total, baseline, target, status)`. `status` is one of `"pass"`, `"fail"`, `"better"` or `"no baseline"`.
  - `main(argv) -> int`, with `--results DIR` (it reads `receipts.json`, `nl.json` and `ask.json`) and `--baselines PATH`.
    - It writes one Markdown table per eval to `$GITHUB_STEP_SUMMARY` if that is set, else to stdout.
    - It prints `::warning::` per warning and `::error::` per failing metric.
    - It returns 1 if any eval failed, else 0.
    - A `"better"` row adds a note with the JSON line to paste into `baselines.json`.

- [ ] **Step 1: Write the failing tests**
  - `test_within_noise_passes`: baseline 0.82/50, run 0.78/50 → `pass` (the allowed drop is 0.05).
  - `test_clear_drop_fails`: baseline 0.82/50, run 0.76/50 → `fail`.
  - `test_small_set_uses_two_cases`: baseline 1.0/8, run 0.75/8 (2 wrong). The allowed drop is 2/8 = 0.25, so it passes. 0.625/8 fails.
  - `test_better_is_flagged`: run 0.86 against 0.82 → row status `better`, and a note containing `"value": 0.86`.
  - `test_no_baseline_never_fails`: nl with empty metrics → every row `no baseline`, verdict `pass`.
  - `test_missing_file_is_a_warning`: `judge(None, …)` → `warn`.
  - `test_incomplete_run_warns_even_if_scores_drop`: cases 50, skipped 6, and a clear drop → `warn`.
  - `test_empty_metric_is_ignored`: a metric with total 0 is left out of the rows.
  - `test_main_exit_codes`: one passing and one failing eval give exit 1; passes and warnings only give exit 0.
  - `test_prints_table_without_step_summary`: with `GITHUB_STEP_SUMMARY` unset, stdout contains `| total_accuracy |`.

- [ ] **Step 2: Run them to verify they fail**
  - Run: `cd services/ai && uv run pytest tests/test_eval_gate.py -q`
  - Expected: FAIL (`ModuleNotFoundError`).

- [ ] **Step 3: Implement** `gate.py` and `baselines.json`.

- [ ] **Step 4: Run the tests to verify they pass.** Same command, plus ruff. Expected: PASS.

- [ ] **Step 5: Commit:** `feat(ai): eval gate against recorded baselines`

---

### Task 3: About 55 more sentences

**Files:**
- Modify: `services/ai/evals/nl/phrases.jsonl`, `services/ai/tests/test_nl_evals_file.py`

- [ ] **Step 1: Write the failing test**
  - `test_nl_evals_file_is_well_formed` now asserts `len(lines) >= 100`.
  - It also asserts that every `expect` validates fully. Build `ParsedSentence.model_validate` from `expect` with `people` mapped to `[{"name": n}]` and the other fields as they are, so every expected value can actually be returned.
  - New `test_no_duplicate_sentences`.

- [ ] **Step 2: Run it to verify it fails**
  - Run: `cd services/ai && uv run pytest tests/test_nl_evals_file.py -q`
  - Expected: FAIL (46 < 100).

- [ ] **Step 3: Write the lines** to the existing format, `today` = `"2026-11-27"`. The mix:
  - 20 expenses, including uneven splits and debts;
  - 8 reminders;
  - 8 payments and cross-offs;
  - 8 questions;
  - 5 unclear sentences;
  - about 10 deliberately hard ones: two amounts, a relative date, someone else paid, a name that looks like a word, "R1,500" and "1.5k".

  The voice is South African: rands, Uber, taxis, braai, groceries, petrol, rent, "my brother", "the guys". Label only the fields the sentence decides.

- [ ] **Step 4: Run the test to verify it passes.** Same command. Expected: PASS.

- [ ] **Step 5: Commit:** `test(ai): grow the plain-language eval set to about 100 sentences`

---

### Task 4: The workflow

**Files:**
- Modify: `.github/workflows/evals.yml`

**Interfaces:**
- Consumes: `--json-out` (Task 1) and `gate.py` (Task 2).
- The job keeps the key check, the models list, the `limit` and `model` inputs, and the 02:17 UTC schedule. Its steps:
  1. Receipts: fetch CORD, then `run_receipts.py --data … --min-total-accuracy 0 --json-out "$RUNNER_TEMP/evals/receipts.json"`.
  2. `nl/run.py --json-out …/nl.json`.
  3. `ask/run.py --json-out …/ask.json`.
  4. `gate.py --results "$RUNNER_TEMP/evals" --baselines evals/baselines.json`.
  5. Upload `$RUNNER_TEMP/evals` as an artifact (`actions/upload-artifact`, pinned by SHA like the other actions).
- Steps 1–3 use `continue-on-error: true`. The gate step decides the job. A missing key still skips everything with the existing notice.

- [ ] **Step 1: Check the file is valid YAML**
  - Run: `cd services/ai && uv run python -c "import yaml,sys; yaml.safe_load(open('../../.github/workflows/evals.yml'))"`
  - If PyYAML isn't installed, use `python -c "import json"` on a converted copy instead, or rely on GitHub's parse in Step 3.
  - Expected: no error.

- [ ] **Step 2: Commit and push the branch:** `ci: run all three evals nightly and gate them on baselines`

- [ ] **Step 3: Run it for real on the branch**
  - Run: `gh workflow run evals.yml --repo flyinginsectsunpig/kitty --ref feat/phase4e-evals-ci`, then watch it with `gh run watch`.
  - Expected:
    - the job finishes;
    - the summary shows three tables;
    - receipts pass against 0.82 (or warn if Gemini is busy);
    - nl shows "no baseline yet".

---

### Task 5: Seed the sentence baseline, docs

**Files:**
- Modify: `services/ai/evals/baselines.json`, `services/ai/evals/README.md`, `docs/superpowers/specs/2026-11-15-kitty-design.md`

- [ ] **Step 1: Seed the sentence baseline** in `baselines.json`, with the nl values from Task 4's run (from its artifact). If that run warned for nl, run it again first.

- [ ] **Step 2: Update the README:**
  - replace "Not in CI" for sentences and Ask Kitty;
  - describe the gate rule, the baselines file and how to raise a baseline;
  - record the run in the results tables.

- [ ] **Step 3: Update the parent design:** in the phase list, 4e is shipped as designed in `2026-11-27-kitty-phase4e-evals-ci-design.md`.

- [ ] **Step 4: Run the ai suite:** `cd services/ai && uv run pytest -q -m "not slow"`. Expected: pass.

- [ ] **Step 5: Commit:** `docs(ai): evals in CI, sentence baseline and phase 4e status`
