import io
import tarfile

import pytest

from helpers import kinds, render, run_script

APPS = ["kitty-ledger", "kitty-web", "kitty-ai", "kitty-pulse", "keycloak"]


def stubs(tmp_path, **scripts):
    """Puts fake commands on PATH. Each logs its argv (one line) to $STUB_LOG, then runs its body."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    log = tmp_path / "stub.log"
    for name, body in scripts.items():
        path = bin_dir / name
        path.write_text(f'#!/usr/bin/env bash\necho "{name} $*" >> "$STUB_LOG"\n{body}\n', encoding="utf-8", newline="\n")
        path.chmod(0o755)
    import os

    return {"PATH": f"{bin_dir.as_posix()}{os.pathsep}{os.environ['PATH']}", "STUB_LOG": log.as_posix()}, log


def calls(log):
    return log.read_text(encoding="utf-8").splitlines() if log.exists() else []


# ---------- smoke.sh


def test_smoke_connect_to_passes_through(tmp_path):
    env, log = stubs(tmp_path, curl="printf 200")
    run_script("deploy/compose/smoke.sh", "h.test", "--connect-to", "127.0.0.1:30443", env=env)
    curl_calls = [c for c in calls(log) if c.startswith("curl ")]
    assert curl_calls
    for c in curl_calls:
        assert "--connect-to h.test:443:127.0.0.1:30443" in c
        assert "https://h.test/" in c
        assert " -k " not in f"{c} "


def test_smoke_rejects_unknown_option(tmp_path):
    env, log = stubs(tmp_path, curl="printf 200")
    result = run_script("deploy/compose/smoke.sh", "h.test", "--bogus", env=env)
    assert result.returncode == 2
    assert not calls(log)


# ---------- backup.sh


def backup_env(tmp_path, curl_exit=0, **extra):
    env, log = stubs(
        tmp_path,
        docker='case "$1" in inspect) echo true;; exec) echo dump;; esac',
        kubectl=('case "$*" in *"get pod"*) echo "${@: -1}" | sed "s/.*=//; s/$/-0/";; *"get svc"*) echo 10.43.0.50;; '
                 '*exec*) echo dump;; esac'),
        curl=f"exit {curl_exit}",
    )
    env.update({"KITTY_BACKUP_DIR": "out",  # relative: GNU tar reads "C:" as a host
                "KITTY_BACKUP_PAR_FILE": (tmp_path / "no-link").as_posix(), **extra})  # fmt: skip
    return env, log


def test_backup_k3s_uses_kubectl(tmp_path):
    env, log = backup_env(tmp_path, KITTY_BACKUP_TARGET="k3s")
    result = run_script("deploy/compose/backup.sh", env=env, cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    c = calls(log)
    assert not [x for x in c if x.startswith("docker ")]
    execs = [x for x in c if x.startswith("kubectl -n kitty exec")]
    assert any("postgres-0 -- pg_dumpall -U postgres --globals-only" in x for x in execs)
    assert any("postgres-0 -- pg_dump -U postgres -Fc ledger" in x for x in execs)
    assert any("postgres-0 -- pg_dump -U postgres -Fc keycloak" in x for x in execs)
    assert any("azurite-0 -- tar czf - -C /data ." in x for x in execs)
    (archive,) = (tmp_path / "out").glob("kitty-*.tar.gz")
    with tarfile.open(archive) as t:
        assert {n.lstrip("./") for n in t.getnames()} >= {"globals.sql", "ledger.dump", "keycloak.dump", "azurite.tar.gz"}


def test_backup_default_is_compose(tmp_path):
    env, log = backup_env(tmp_path)
    result = run_script("deploy/compose/backup.sh", env=env, cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    c = calls(log)
    assert not [x for x in c if x.startswith("kubectl ")]
    assert any(x.startswith("docker exec kitty-postgres-1 pg_dump -U postgres -Fc ledger") for x in c)


def test_backup_reports_last_success(tmp_path):
    env, log = backup_env(tmp_path, KITTY_BACKUP_TARGET="k3s")
    result = run_script("deploy/compose/backup.sh", env=env, cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    (report,) = [x for x in calls(log) if x.startswith("curl ") and "/v1/metrics" in x]
    assert "http://10.43.0.50:4318/v1/metrics" in report
    for needle in ("kitty.backup.last_success", "kitty.backup.size_bytes", '"kitty-backup"'):
        assert needle in report, needle


def test_backup_succeeds_when_reporting_fails(tmp_path):
    # Review Focus 5: the collector unreachable never fails the backup itself.
    env, _ = backup_env(tmp_path, curl_exit=7, KITTY_BACKUP_TARGET="k3s")
    result = run_script("deploy/compose/backup.sh", env=env, cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    assert "backup ok" in result.stdout
    assert "reporting it failed" in result.stdout + result.stderr
    assert list((tmp_path / "out").glob("kitty-*.tar.gz"))


def test_compose_mode_does_not_report(tmp_path):
    env, log = backup_env(tmp_path)
    assert run_script("deploy/compose/backup.sh", env=env, cwd=tmp_path).returncode == 0
    assert not [x for x in calls(log) if "/v1/metrics" in x]


def test_backup_rejects_unknown_target(tmp_path):
    env, log = backup_env(tmp_path, KITTY_BACKUP_TARGET="nomad")
    assert run_script("deploy/compose/backup.sh", env=env, cwd=tmp_path).returncode == 2
    assert not calls(log)


# ---------- restore.sh


def archive(tmp_path):
    path = tmp_path / "kitty-2026-11-28T0117Z.tar.gz"
    with tarfile.open(path, "w:gz") as t:
        for name in ["globals.sql", "ledger.dump", "keycloak.dump", "azurite.tar.gz"]:
            data = name.encode()
            info = tarfile.TarInfo(f"./{name}")
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    return path


def test_restore_order(tmp_path):
    env, log = stubs(tmp_path, kubectl='case "$*" in *"get pod"*) echo "${@: -1}" | sed "s/.*=//; s/$/-0/";; esac')
    result = run_script("deploy/k3s/restore.sh", archive(tmp_path).name, env=env, cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    c = [x for x in calls(log) if "get pod" not in x]

    def first(pred):
        return next(i for i, x in enumerate(c) if pred(x))

    down = first(lambda x: "scale deployment" in x and "--replicas=0" in x)
    assert all(a in c[down] for a in APPS)
    globals_ = first(lambda x: "postgres-0 -- psql -U postgres" in x)
    ledger = first(lambda x: "pg_restore" in x and " -d ledger" in x)
    keycloak = first(lambda x: "pg_restore" in x and " -d keycloak" in x)
    up = first(lambda x: "scale deployment" in x and "--replicas=1" in x)
    assert down < globals_ < ledger < keycloak < up
    drop = first(lambda x: "dropdb" in x and x.endswith(" ledger"))
    assert "--if-exists" in c[drop] and "--force" in c[drop]  # a leftover connection must not stall the switch
    assert drop < ledger


def test_restore_puts_photos_back_while_azurite_is_stopped(tmp_path):
    # Azurite keeps its blob index in memory and writes it back on the next change: files untarred under a running
    # Azurite are invisible, then overwritten. So it is stopped, a throwaway pod fills its volume, and it starts again.
    env, log = stubs(tmp_path, kubectl='case "$*" in *"get pod"*) echo "${@: -1}" | sed "s/.*=//; s/$/-0/";; esac')
    result = run_script("deploy/k3s/restore.sh", archive(tmp_path).name, env=env, cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    c = calls(log)

    def first(pred):
        return next(i for i, x in enumerate(c) if pred(x))

    stop = first(lambda x: "scale statefulset azurite --replicas=0" in x)
    fill = first(lambda x: " run " in x and "restore-photos" in x)
    start = first(lambda x: "scale statefulset azurite --replicas=1" in x)
    assert stop < fill < start
    assert '"claimName":"data-azurite-0"' in c[fill].replace(" ", "")
    assert "tar xzf - -C /data" in c[fill]
    assert not [x for x in c if " exec " in x and "azurite" in x]  # never into the running Azurite


def test_restore_no_start_leaves_the_apps_stopped(tmp_path):
    # At the switch the data is compared before anything writes to it again.
    env, log = stubs(tmp_path, kubectl='case "$*" in *"get pod"*) echo "${@: -1}" | sed "s/.*=//; s/$/-0/";; esac')
    result = run_script("deploy/k3s/restore.sh", archive(tmp_path).name, "--no-start", env=env, cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    c = calls(log)
    assert not [x for x in c if "scale deployment" in x and "--replicas=1" in x]
    assert any("scale statefulset azurite --replicas=1" in x for x in c)  # storage itself comes back
    assert "--replicas=1" in result.stdout  # says how to start the apps


def test_restore_refuses_without_archive(tmp_path):
    env, log = stubs(tmp_path, kubectl="")
    result = run_script("deploy/k3s/restore.sh", tmp_path / "missing.tar.gz", env=env)
    assert result.returncode == 2
    assert not calls(log)


@pytest.mark.parametrize("chart", ["kitty-ledger", "kitty-web", "kitty-ai", "kitty-pulse", "keycloak"])
def test_restore_can_scale_without_argo_undoing_it(chart):
    # No replicas in git, so Argo CD's self-heal leaves a manual scale (restore.sh) alone; Kubernetes defaults to 1.
    for d in kinds(render(chart), "Deployment"):
        assert "replicas" not in d["spec"], d["metadata"]["name"]


def test_azurite_can_be_stopped_for_a_restore():
    (sts,) = kinds(render("azurite"), "StatefulSet")
    assert "replicas" not in sts["spec"]


# ---------- compare-data.sh


def test_compare_reports_difference(tmp_path):
    env, log = stubs(
        tmp_path,
        docker='if [[ "$*" == *" -c "* ]]; then echo "select 1;"; else cat >/dev/null; echo "public.expenses 3 aaa"; fi',
        kubectl=('case "$*" in *"get pod"*) echo postgres-0;; *" -c "*) echo "select 1;";; '
                 '*) cat >/dev/null; echo "public.expenses 3 bbb";; esac'),
    )  # fmt: skip
    result = run_script("deploy/k3s/compare-data.sh", env=env)
    assert result.returncode != 0
    assert "public.expenses" in result.stdout


def test_compare_passes_when_identical(tmp_path):
    same = 'echo "public.expenses 3 aaa"'
    env, _ = stubs(
        tmp_path,
        docker=f'if [[ "$*" == *" -c "* ]]; then echo "select 1;"; else cat >/dev/null; {same}; fi',
        kubectl=f'case "$*" in *"get pod"*) echo postgres-0;; *" -c "*) echo "select 1;";; *) cat >/dev/null; {same};; esac',
    )
    result = run_script("deploy/k3s/compare-data.sh", env=env)
    assert result.returncode == 0, result.stdout + result.stderr
