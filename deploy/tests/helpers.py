"""Shared helpers for the deploy tests: render a chart with its production values and read the Compose file.

Run from the repository root:  uv run --with pytest --with pyyaml pytest deploy/tests
Needs `helm` on PATH.
"""

import functools
import os
import pathlib
import shutil
import subprocess

import yaml

REPO = pathlib.Path(__file__).resolve().parents[2]
CHARTS = REPO / "deploy" / "charts"
VALUES = REPO / "deploy" / "values" / "production"

KITTY_CHARTS = ["kitty-ledger", "kitty-web", "kitty-ai", "kitty-pulse"]
SUPPORT_CHARTS = ["postgres", "keycloak", "redis", "redpanda", "azurite"]
EDGE_CHART = "kitty-edge"


def render(chart: str, *extra: str) -> list[dict]:
    """`helm template` the chart with its production values (plus any extra helm arguments), parsed."""
    return list(_render(chart, extra))


@functools.lru_cache(maxsize=None)
def _render(chart: str, extra: tuple[str, ...]) -> tuple[dict, ...]:
    cmd = ["helm", "template", chart, str(CHARTS / chart), "-f", str(VALUES / f"{chart}.yaml"), "--namespace", "kitty"]
    out = subprocess.run([*cmd, *extra], check=True, capture_output=True, text=True).stdout
    return tuple(d for d in yaml.safe_load_all(out) if d)


def kinds(docs: list[dict], kind: str) -> list[dict]:
    return [d for d in docs if d.get("kind") == kind]


def one(docs: list[dict], kind: str, name: str | None = None) -> dict:
    found = [d for d in kinds(docs, kind) if name is None or d["metadata"]["name"] == name]
    assert len(found) == 1, f"expected one {kind} {name or ''}, found {len(found)}"
    return found[0]


@functools.lru_cache(maxsize=None)
def compose() -> dict:
    return yaml.safe_load((REPO / "deploy" / "compose" / "docker-compose.yml").read_text(encoding="utf-8"))


def run_script(script: str, *args, env: dict | None = None, cwd=None) -> subprocess.CompletedProcess:
    """Runs a repo bash script (path relative to the repo root) with Git Bash / bash, capturing output."""
    bash = shutil.which("bash")
    assert bash, "bash not found"
    argv = [bash, (REPO / script).as_posix(), *(a.as_posix() if isinstance(a, pathlib.Path) else str(a) for a in args)]
    full_env = {**os.environ, **(env or {})}
    return subprocess.run(argv, capture_output=True, text=True, env=full_env, cwd=cwd or REPO)


def pod_spec(workload: dict) -> dict:
    return workload["spec"]["template"]["spec"]


def container(workload: dict, name: str | None = None) -> dict:
    cs = pod_spec(workload)["containers"]
    return cs[0] if name is None else next(c for c in cs if c["name"] == name)


def env(c: dict) -> dict[str, dict]:
    """Container env as {name: entry}, in order."""
    return {e["name"]: e for e in c.get("env", [])}
