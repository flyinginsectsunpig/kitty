import shutil
import subprocess

import pytest

from helpers import KITTY_CHARTS, REPO

SCRIPT = "deploy/k3s/set-image-tag.sh"


def copy_of_deploy(tmp_path):
    shutil.copytree(REPO / "deploy" / "values", tmp_path / "deploy" / "values")
    (tmp_path / "deploy" / "k3s").mkdir(parents=True)
    shutil.copy(REPO / SCRIPT, tmp_path / SCRIPT)
    return {p.relative_to(tmp_path).as_posix(): p.read_text(encoding="utf-8") for p in (tmp_path / "deploy").rglob("*.yaml")}


def run(tmp_path, tag):
    # Relative paths, run from the copy: the script edits the values next to itself.
    return subprocess.run([shutil.which("bash"), SCRIPT, tag], cwd=tmp_path, capture_output=True, text=True)


def test_updates_the_four_values_files(tmp_path):
    before = copy_of_deploy(tmp_path)
    result = run(tmp_path, "sha-abc1234")
    assert result.returncode == 0, result.stderr
    after = {p.relative_to(tmp_path).as_posix(): p.read_text(encoding="utf-8") for p in (tmp_path / "deploy").rglob("*.yaml")}
    changed = {f for f in before if before[f] != after[f]}
    assert changed == {f"deploy/values/production/{c}.yaml" for c in KITTY_CHARTS}
    for f in changed:
        old, new = before[f].splitlines(), after[f].splitlines()
        assert len(old) == len(new)
        diffs = [(a, b) for a, b in zip(old, new) if a != b]
        assert len(diffs) == 1 and diffs[0][1] == "  tag: sha-abc1234", diffs


@pytest.mark.parametrize("tag", ["latest", "sha-XYZ1234", "sha-abc123", "", "sha-abc1234; rm -rf /"])
def test_rejects_bad_tags(tmp_path, tag):
    before = copy_of_deploy(tmp_path)
    result = run(tmp_path, tag)
    assert result.returncode == 2
    after = {p.relative_to(tmp_path).as_posix(): p.read_text(encoding="utf-8") for p in (tmp_path / "deploy").rglob("*.yaml")}
    assert before == after
