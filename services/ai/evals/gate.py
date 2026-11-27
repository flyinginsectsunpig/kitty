"""Compares tonight's eval scores with the best recorded ones (evals/baselines.json) and decides the CI run.

- fail: a metric fell more than max(2 cases, 5 points) below its baseline: a real drop, not noise.
- warn: the model was too busy to finish (more than max(2, 10% of cases) skipped), or an eval wrote no scores.
  A busy model makes the scores unreliable, so this wins over a drop.
- pass: everything else, including metrics with no baseline yet. A score above its baseline is flagged with the
  line to paste into baselines.json (raising a baseline is a deliberate, reviewed change).

Writes one table per eval to $GITHUB_STEP_SUMMARY (stdout when that isn't set) and exits 1 only on a fail.

Usage (from services/ai): uv run python evals/gate.py --results DIR --baselines evals/baselines.json
"""

import argparse
import json
import os
import pathlib
import sys
from dataclasses import dataclass, field
from typing import Literal

EVALS = ("receipts", "nl", "ask")
TITLES = {"receipts": "Receipts", "nl": "Plain-language sentences", "ask": "Ask Kitty"}
NOISE_CASES, NOISE_POINTS = 2, 0.05
SKIP_CASES, SKIP_SHARE = 2, 0.10
EPSILON = 1e-9


@dataclass(frozen=True)
class Row:
    metric: str
    value: float
    total: int
    baseline: float | None
    target: float | None
    status: Literal["pass", "fail", "better", "no baseline", "not judged"]


@dataclass
class Verdict:
    status: Literal["pass", "warn", "fail"]
    rows: list[Row] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def judge(result: dict | None, baseline: dict) -> Verdict:
    if result is None:
        return Verdict("warn", notes=["No scores: the eval didn't finish (see its step's log)."])
    known = baseline.get("metrics", {})
    targets = baseline.get("target", {})
    rows: list[Row] = []
    notes: list[str] = []
    for name, m in result["metrics"].items():
        value, total = m["value"], m["total"]
        if not total:
            continue
        base = known.get(name)
        if base is None:
            status = "no baseline"
        elif value < base["value"] - max(NOISE_CASES / total, NOISE_POINTS) - EPSILON:
            status = "fail"
        elif value > base["value"] + EPSILON:
            status = "better"
            line = json.dumps({name: {"value": value, "total": total}})[1:-1]
            notes.append(f"{name} beat its baseline: to keep it, put {line} in baselines.json.")
        else:
            status = "pass"
        rows.append(Row(name, value, total, base["value"] if base else None, targets.get(name), status))

    skipped, cases = result.get("skipped", 0), result.get("cases", 0)
    if skipped > max(SKIP_CASES, SKIP_SHARE * cases):
        # The scores aren't reliable: shown, but neither a drop nor a new best counts.
        judged_rows = [Row(r.metric, r.value, r.total, r.baseline, r.target, "not judged") for r in rows]
        note = f"Incomplete: the model never answered {skipped} of {cases} cases, so nothing is judged."
        return Verdict("warn", judged_rows, [note])
    return Verdict("fail" if any(r.status == "fail" for r in rows) else "pass", rows, notes)


def _pct(value: float | None) -> str:
    return "–" if value is None else f"{value:.1%}"


def table(name: str, result: dict | None, verdict: Verdict) -> str:
    icon = {"pass": "✅", "warn": "⚠️", "fail": "❌"}[verdict.status]
    head = f"### {icon} {TITLES.get(name, name)}"
    if result:
        head += f" · {result.get('model', '?')} · {result.get('cases', 0)} cases, {result.get('skipped', 0)} skipped"
    lines = [head, ""]
    if verdict.rows:
        lines += ["| metric | score | over | baseline | target | |", "|---|---|---|---|---|---|"]
        lines += [
            f"| {r.metric} | {_pct(r.value)} | {r.total} | {_pct(r.baseline)} | {_pct(r.target)} | {r.status} |"
            for r in verdict.rows
        ]
    lines += [f"- {note}" for note in verdict.notes]
    return "\n".join(lines) + "\n\n"


def main(argv: list[str] | None = None) -> int:
    args = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    args.add_argument("--results", type=pathlib.Path, required=True)
    args.add_argument("--baselines", type=pathlib.Path, required=True)
    opts = args.parse_args(argv)

    baselines = json.loads(opts.baselines.read_text(encoding="utf-8"))
    out, failed = ["## AI evals\n\n"], False
    for name in EVALS:
        if name not in baselines:
            continue
        path = opts.results / f"{name}.json"
        result = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
        verdict = judge(result, baselines[name])
        out.append(table(name, result, verdict))
        if verdict.status == "warn":
            print(f"::warning::{TITLES[name]}: {verdict.notes[0] if verdict.notes else 'incomplete'}")
        if verdict.status == "fail":
            failed = True
            for row in (r for r in verdict.rows if r.status == "fail"):
                print(f"::error::{TITLES[name]}: {row.metric} {_pct(row.value)}, baseline {_pct(row.baseline)}")

    text = "".join(out)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(text)
    else:
        print(text)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # a Windows console defaults to cp1252, which has no ✅
    sys.exit(main())
