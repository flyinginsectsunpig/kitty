import importlib.util
import json
import pathlib

EVALS = pathlib.Path(__file__).resolve().parents[1] / "evals"
spec = importlib.util.spec_from_file_location("eval_gate", EVALS / "gate.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

RECEIPTS_BASE = {"target": {"total_accuracy": 0.9}, "metrics": {"total_accuracy": {"value": 0.82, "total": 50}}}


def result(value: float, total: int = 50, cases: int = 50, skipped: int = 0, metric: str = "total_accuracy") -> dict:
    return {"eval": "receipts", "model": "m", "cases": cases, "skipped": skipped,
            "metrics": {metric: {"value": value, "total": total}}}  # fmt: skip


def test_within_noise_passes():
    assert gate.judge(result(0.78), RECEIPTS_BASE).status == "pass"


def test_clear_drop_fails():
    verdict = gate.judge(result(0.76), RECEIPTS_BASE)
    assert verdict.status == "fail"
    assert verdict.rows[0].status == "fail"


def test_small_set_uses_two_cases():
    base = {"metrics": {"not_contains": {"value": 1.0, "total": 8}}}
    assert gate.judge(result(0.75, total=8, metric="not_contains"), base).status == "pass"
    assert gate.judge(result(0.625, total=8, metric="not_contains"), base).status == "fail"


def test_better_is_flagged():
    verdict = gate.judge(result(0.86), RECEIPTS_BASE)
    assert verdict.status == "pass"
    assert verdict.rows[0].status == "better"
    assert any('"value": 0.86' in note for note in verdict.notes)


def test_no_baseline_never_fails():
    verdict = gate.judge(result(0.1, metric="intent"), {"metrics": {}})
    assert verdict.status == "pass"
    assert [r.status for r in verdict.rows] == ["no baseline"]


def test_missing_file_is_a_warning():
    assert gate.judge(None, RECEIPTS_BASE).status == "warn"


def test_incomplete_run_warns_even_if_scores_drop():
    assert gate.judge(result(0.5, total=44, skipped=6), RECEIPTS_BASE).status == "warn"


def test_a_few_skipped_still_judges():
    assert gate.judge(result(0.5, total=48, skipped=2), RECEIPTS_BASE).status == "fail"


def test_empty_metric_is_ignored():
    verdict = gate.judge(result(0.0, total=0), RECEIPTS_BASE)
    assert verdict.rows == []


def test_target_is_shown():
    assert gate.judge(result(0.8), RECEIPTS_BASE).rows[0].target == 0.9


def write(dir_: pathlib.Path, name: str, body: dict) -> None:
    (dir_ / f"{name}.json").write_text(json.dumps(body), encoding="utf-8")


def test_main_exit_codes(tmp_path, monkeypatch):
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    baselines = tmp_path / "baselines.json"
    baselines.write_text(json.dumps({"receipts": RECEIPTS_BASE, "nl": {"metrics": {}}, "ask": {"metrics": {}}}))
    results = tmp_path / "results"
    results.mkdir()
    write(results, "receipts", result(0.80))
    # nl passes (no baseline); ask has no file: a warning
    write(results, "nl", result(0.9, metric="intent") | {"eval": "nl"})
    assert gate.main(["--results", str(results), "--baselines", str(baselines)]) == 0
    write(results, "receipts", result(0.70))
    assert gate.main(["--results", str(results), "--baselines", str(baselines)]) == 1


def test_prints_table_without_step_summary(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)
    baselines = tmp_path / "baselines.json"
    baselines.write_text(json.dumps({"receipts": RECEIPTS_BASE}))
    results = tmp_path / "results"
    results.mkdir()
    write(results, "receipts", result(0.80))
    gate.main(["--results", str(results), "--baselines", str(baselines)])
    assert "| total_accuracy |" in capsys.readouterr().out


def test_writes_step_summary(tmp_path, monkeypatch):
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    baselines = tmp_path / "baselines.json"
    baselines.write_text(json.dumps({"receipts": RECEIPTS_BASE}))
    results = tmp_path / "results"
    results.mkdir()
    write(results, "receipts", result(0.80))
    gate.main(["--results", str(results), "--baselines", str(baselines)])
    assert "| total_accuracy |" in summary.read_text(encoding="utf-8")


def test_committed_baselines_are_well_formed():
    data = json.loads((EVALS / "baselines.json").read_text(encoding="utf-8"))
    assert set(data) == {"receipts", "nl", "ask"}
    assert data["receipts"]["metrics"]["total_accuracy"] == {"value": 0.82, "total": 50}
    assert data["receipts"]["target"]["total_accuracy"] == 0.9
    assert set(data["ask"]["metrics"]) == {"calls", "contains", "not_contains", "entry"}
