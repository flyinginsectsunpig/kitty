"""Sends deliberately dirty telemetry through the real Collector, with the scrubbing processors copied from
deploy/values/production/otel-collector.yaml, and checks nothing personal comes out. Needs Docker."""

import json
import pathlib
import shutil
import subprocess
import time
import urllib.error
import urllib.request

import pytest
import yaml

from helpers import REPO

IMAGE = "otel/opentelemetry-collector-contrib:0.165.0"
FIXTURES = REPO / "deploy" / "tests" / "scrub"
SCRUBBERS = ["filter/noise", "attributes/kitty", "transform/kitty"]
LEAKS = ["bob@", "eyJ", "Bearer", "abc123", "client.address", "ClientHost", "url.query", "url.full", "url.path",
         "RequestPath", "Pizza", "enduser.", "AIzaSy", "AQ.Ab", "10.0.0.213", "http.request.header", "db.statement",
         # review fix pass: span names, events, status, resources; Keycloak details, SAS URLs, IPv6; series budget
         "x=1", "frank@", "dave@", "erin@", "carol.typed", "Carol", "SASsecretSIG", "2001:db8", "kestrel.",
         "k8s.volume", "go_goroutines", "certmanager_controller"]
KEPT = ["/groups/{groupId}/expenses", "SELECT", "expenses", "kitty.receipts.read", "fetch POST", "LOGIN_ERROR",
        "user_not_found", "exception"]


def docker_ok() -> bool:
    return shutil.which("docker") is not None and subprocess.run(["docker", "info"], capture_output=True).returncode == 0


@pytest.fixture(scope="module")
def scrubbed(tmp_path_factory) -> str:
    if not docker_ok():
        pytest.skip("Docker isn't running")
    work = tmp_path_factory.mktemp("scrub")
    (work / "out").mkdir()
    values = yaml.safe_load((REPO / "deploy/values/production/otel-collector.yaml").read_text(encoding="utf-8"))
    processors = {name: values["config"]["processors"][name] for name in SCRUBBERS}
    cfg = {
        "receivers": {"otlp": {"protocols": {"http": {"endpoint": "0.0.0.0:4318"}}}},
        "processors": processors,
        "exporters": {"file": {"path": "/out/out.json"}},
        "service": {"pipelines": {
            s: {"receivers": ["otlp"], "processors": SCRUBBERS, "exporters": ["file"]} for s in ("traces", "logs", "metrics")
        }},
    }  # fmt: skip
    (work / "config.yaml").write_text(yaml.safe_dump(cfg), encoding="utf-8")
    # The image runs as a non-root user: on Linux it can't read pytest's 0700 temp dir (Docker Desktop doesn't care).
    work.chmod(0o755)
    (work / "config.yaml").chmod(0o644)
    (work / "out").chmod(0o777)
    name = f"kitty-scrub-{int(time.time())}"
    subprocess.run(["docker", "run", "-d", "--name", name, "-p", "127.0.0.1::4318",
                    "-v", f"{work.as_posix()}:/conf", "-v", f"{(work / 'out').as_posix()}:/out",
                    IMAGE, "--config", "/conf/config.yaml"], check=True, capture_output=True)  # fmt: skip
    try:
        port = subprocess.run(["docker", "port", name, "4318"], check=True, capture_output=True, text=True)
        url = "http://" + port.stdout.strip().splitlines()[0].replace("0.0.0.0", "127.0.0.1")
        for _ in range(60):
            try:
                urllib.request.urlopen(url + "/v1/traces", data=b"{}", timeout=2)
                break
            except urllib.error.HTTPError:  # any answer (415 for this bare ping) means it's listening
                break
            except Exception:
                time.sleep(1)
        else:  # never listened: show why (the container is kept until finally, so its log is still there)
            logs = subprocess.run(["docker", "logs", name], capture_output=True, text=True)
            pytest.fail(f"the Collector never started:\n{logs.stdout}{logs.stderr}")
        for signal in ("traces", "logs", "metrics"):
            body = (FIXTURES / f"dirty-{signal}.json").read_bytes()
            req = urllib.request.Request(f"{url}/v1/{signal}", data=body, headers={"Content-Type": "application/json"})
            assert urllib.request.urlopen(req, timeout=10).status == 200
        out = work / "out" / "out.json"
        for _ in range(30):
            if out.exists() and out.read_text(encoding="utf-8").count("\n") >= 3:
                break
            time.sleep(1)
        return out.read_text(encoding="utf-8")
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)


@pytest.mark.parametrize("leak", LEAKS)
def test_nothing_personal_leaves(scrubbed, leak):
    assert leak not in scrubbed


@pytest.mark.parametrize("kept", KEPT)
def test_useful_fields_survive(scrubbed, kept):
    assert kept in scrubbed


def test_noise_is_dropped(scrubbed):
    assert "coredns" not in scrubbed  # kube-system logs aren't shipped
    assert '"/health"' not in scrubbed  # health-check spans aren't shipped


def test_all_three_signals_came_through(scrubbed):
    lines = [json.loads(line) for line in scrubbed.splitlines() if line.strip()]
    assert any("resourceSpans" in x for x in lines)
    assert any("resourceLogs" in x for x in lines)
    assert any("resourceMetrics" in x for x in lines)
