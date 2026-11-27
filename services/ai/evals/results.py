"""The scores an eval script writes for the CI gate (evals/gate.py): one JSON file per eval.

    {"eval": "nl", "model": "...", "cases": 101, "skipped": 0, "metrics": {"intent": {"value": 0.99, "total": 101}}}

"skipped" counts cases the model never answered (still busy after the retries): they are left out of the metrics,
so a busy night shows as incomplete rather than as wrong answers."""

import json
from dataclasses import dataclass
from pathlib import Path

from kitty_ai.settings import Settings


@dataclass(frozen=True)
class Metric:
    value: float
    total: int


def ratio(right: int, total: int) -> Metric:
    return Metric(right / total if total else 0.0, total)


def model_name(settings: Settings | None = None) -> str:
    settings = settings or Settings()
    return settings.gemini_model if settings.gemini_api_key else f"ollama:{settings.ollama_model}"


def write_results(
    path: Path,
    eval_name: str,
    model: str,
    cases: int,
    skipped: int,
    metrics: dict[str, Metric],
    extra: dict | None = None,
) -> None:
    body = {
        "eval": eval_name,
        "model": model,
        "cases": cases,
        "skipped": skipped,
        "metrics": {name: {"value": round(m.value, 4), "total": m.total} for name, m in metrics.items()},
    } | (extra or {})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
