import functools
import subprocess

import yaml

from helpers import REPO, kinds

CHART_REPO = "https://open-telemetry.github.io/opentelemetry-helm-charts"
VERSION = "0.183.2"
VALUES = REPO / "deploy" / "values" / "production" / "otel-collector.yaml"


@functools.lru_cache(maxsize=None)
def rendered() -> tuple[dict, ...]:
    out = subprocess.run(
        ["helm", "template", "otel-collector", "opentelemetry-collector", "--repo", CHART_REPO, "--version", VERSION,
         "--namespace", "observability", "-f", str(VALUES)],
        check=True, capture_output=True, text=True,
    ).stdout  # fmt: skip
    return tuple(d for d in yaml.safe_load_all(out) if d)


def collector_config() -> dict:
    (cm,) = [d for d in kinds(list(rendered()), "ConfigMap") if "relay" in d.get("data", {})]
    return yaml.safe_load(cm["data"]["relay"])


def apps():
    out = subprocess.run(["helm", "template", "kitty-apps", str(REPO / "deploy" / "apps"), "--set", "revision=main"],
                         check=True, capture_output=True, text=True).stdout  # fmt: skip
    return {d["metadata"]["name"]: d for d in yaml.safe_load_all(out) if d and d.get("kind") == "Application"}


def test_collector_application_is_pinned():
    # Two sources: the upstream chart, and this repository (ref "values") for the values file.
    app = apps()["otel-collector"]
    chart, values = app["spec"]["sources"]
    assert (chart["repoURL"], chart["chart"], chart["targetRevision"]) == (CHART_REPO, "opentelemetry-collector", VERSION)
    assert chart["helm"]["valueFiles"] == ["$values/deploy/values/production/otel-collector.yaml"]
    assert (values["repoURL"], values["targetRevision"], values["ref"]) == (
        "https://github.com/flyinginsectsunpig/kitty.git", "main", "values")
    assert app["spec"]["destination"]["namespace"] == "observability"


def test_runs_as_one_daemonset_with_a_service():
    docs = list(rendered())
    (ds,) = kinds(docs, "DaemonSet")
    assert ds["metadata"]["name"] == "otel-collector-agent"  # the chart suffixes DaemonSets
    c = ds["spec"]["template"]["spec"]["containers"][0]
    assert c["image"] == "otel/opentelemetry-collector-contrib:0.165.0"
    assert c["resources"]["limits"]["memory"] == "256Mi"
    (svc,) = kinds(docs, "Service")
    assert svc["metadata"]["name"] == "otel-collector"
    assert {p["port"] for p in svc["spec"]["ports"]} >= {4317, 4318}


def test_every_pipeline_scrubs_before_export():
    pipelines = collector_config()["service"]["pipelines"]
    assert set(pipelines) == {"traces", "metrics", "logs"}
    for name, p in pipelines.items():
        procs = p["processors"]
        # The kubernetesAttributes preset always prepends k8s_attributes; memory_limiter comes right after.
        assert procs[:2] == ["k8s_attributes", "memory_limiter"], name
        for scrub in ("attributes/kitty", "transform/kitty"):
            assert procs.index(scrub) < procs.index("batch"), (name, scrub)
        assert p["exporters"] == ["otlp_http/grafana"], name
    assert "jaeger" not in collector_config()["receivers"]
    assert "zipkin" not in collector_config()["receivers"]


def test_grafana_credentials_come_from_the_secret():
    (ds,) = kinds(list(rendered()), "DaemonSet")
    env = {e["name"]: e for e in ds["spec"]["template"]["spec"]["containers"][0]["env"]}
    for key in ("GRAFANA_OTLP_ENDPOINT", "GRAFANA_OTLP_INSTANCE_ID", "GRAFANA_OTLP_TOKEN"):
        assert env[key]["valueFrom"]["secretKeyRef"] == {"name": "grafana-cloud", "key": key}
    cfg = collector_config()
    assert cfg["exporters"]["otlp_http/grafana"]["endpoint"] == "${env:GRAFANA_OTLP_ENDPOINT}"
    assert cfg["extensions"]["basicauth/grafana"]["client_auth"] == {
        "username": "${env:GRAFANA_OTLP_INSTANCE_ID}", "password": "${env:GRAFANA_OTLP_TOKEN}"}


def test_collects_cluster_logs_metrics_and_scrapes():
    cfg = collector_config()
    receivers = cfg["receivers"]
    assert {"file_log", "kubelet_stats", "k8s_cluster", "prometheus", "otlp"} <= set(receivers)  # the chart's current names
    jobs = {j["job_name"] for j in receivers["prometheus"]["config"]["scrape_configs"]}
    assert jobs >= {"opentelemetry-collector", "cert-manager", "traefik"}
