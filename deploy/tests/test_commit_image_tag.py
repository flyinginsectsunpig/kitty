import shutil
import subprocess

from helpers import REPO

SCRIPTS = ["deploy/k3s/commit-image-tag.sh", "deploy/k3s/set-image-tag.sh"]


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def make_repo(tmp_path):
    repo = tmp_path / "repo"
    shutil.copytree(REPO / "deploy" / "values", repo / "deploy" / "values")
    (repo / "deploy" / "k3s").mkdir(parents=True)
    for s in SCRIPTS:
        shutil.copy(REPO / s, repo / s)
    git(repo, "init", "-q", "-b", "main")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "add", ".")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "feat: code A")
    return repo


def commit(repo, message, file="code.txt"):
    (repo / file).write_text(message, encoding="utf-8")
    git(repo, "add", ".")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message)
    return git(repo, "rev-parse", "HEAD")


def run(repo, sha):
    return subprocess.run([shutil.which("bash"), "deploy/k3s/commit-image-tag.sh", sha], cwd=repo,
                          capture_output=True, text=True)  # fmt: skip


def tag_in(repo):
    return (repo / "deploy/values/production/kitty-web.yaml").read_text(encoding="utf-8").split("tag: ")[1].split()[0]


def test_writes_and_commits_the_tag(tmp_path):
    repo = make_repo(tmp_path)
    a = git(repo, "rev-parse", "HEAD")
    result = run(repo, a)
    assert result.returncode == 0, result.stderr
    assert tag_in(repo) == f"sha-{a[:7]}"
    assert git(repo, "log", "-1", "--format=%s") == f"chore(deploy): images sha-{a[:7]} [skip ci]"
    assert git(repo, "status", "--porcelain") == ""


def test_writes_over_an_earlier_tag_commit(tmp_path):
    # main's tip being a [skip ci] tag commit (another run's) must not hide this run's own code commit.
    repo = make_repo(tmp_path)
    b = commit(repo, "feat: code B")
    commit(repo, "chore(deploy): images sha-0000000 [skip ci]", file="deploy/values/production/note.txt")
    result = run(repo, b)
    assert result.returncode == 0, result.stderr
    assert tag_in(repo) == f"sha-{b[:7]}"


def test_never_rolls_back_to_an_older_commit(tmp_path):
    repo = make_repo(tmp_path)
    a = git(repo, "rev-parse", "HEAD")
    commit(repo, "feat: code B")
    before = git(repo, "rev-parse", "HEAD")
    result = run(repo, a)
    assert result.returncode == 0, result.stderr
    assert "moved on" in result.stdout
    assert git(repo, "rev-parse", "HEAD") == before


def test_rejects_a_bad_sha(tmp_path):
    repo = make_repo(tmp_path)
    assert run(repo, "abc").returncode == 2
