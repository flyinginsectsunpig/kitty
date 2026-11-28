import re

import pytest

from helpers import KITTY_CHARTS, REPO, compose, container, env, one, pod_spec, render

HOST = "kitty-split.duckdns.org"
# chart -> (Compose service, Deployment/container name)
SERVICE = {"kitty-ledger": "ledger", "kitty-web": "web", "kitty-ai": "ai", "kitty-pulse": "pulse"}
# Variables Kubernetes needs only to build other values with $(NAME) (Compose interpolated them from .env instead).
HELPERS = {"POSTGRES_PASSWORD", "BLOB_ACCOUNT_KEY", "AI_DB_PASSWORD", "PULSE_DB_PASSWORD", "SMTP_FROM"}
# OpenTelemetry's standard variables (phase 5b), only when the chart's otel.endpoint is set.
OTEL = {"OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_PROTOCOL", "OTEL_SERVICE_NAME", "OTEL_LOGS_EXPORTER",
        "OTEL_RESOURCE_ATTRIBUTES", "OTEL_SEMCONV_STABILITY_OPT_IN"}
LIMITS = {"kitty-ledger": "512Mi", "kitty-web": "512Mi", "kitty-ai": "1500Mi", "kitty-pulse": "128Mi"}


def deployment(chart, *extra):
    return one(render(chart, *extra), "Deployment", chart)


def main(chart, *extra):
    return container(deployment(chart, *extra), SERVICE[chart])


@pytest.mark.parametrize("chart", KITTY_CHARTS)
def test_env_names_match_compose(chart):
    names = set(env(main(chart)))
    wanted = set(compose()["services"][SERVICE[chart]]["environment"])
    assert wanted <= names, f"missing: {sorted(wanted - names)}"
    assert names - wanted <= HELPERS | OTEL, f"unexpected: {sorted(names - wanted - HELPERS - OTEL)}"


@pytest.mark.parametrize("chart", KITTY_CHARTS)
def test_helpers_come_before_their_use(chart):
    names = list(env(main(chart)))
    for i, (name, entry) in enumerate(env(main(chart)).items()):
        for ref in re.findall(r"\$\((\w+)\)", entry.get("value", "")):
            assert ref in names[:i], f"{name} uses $({ref}) before it is defined"


def test_connection_values():
    ledger = env(main("kitty-ledger"))
    assert ledger["ConnectionStrings__ledger"]["value"] == (
        "Host=postgres;Database=ledger;Username=postgres;Password=$(POSTGRES_PASSWORD)"
    )
    assert ledger["Auth__Authority"]["value"] == f"https://{HOST}/auth/realms/kitty"
    assert ledger["ASPNETCORE_HTTP_PORTS"]["value"] == "8080;8082"
    assert ledger["Blob__PublicUrl"]["value"] == f"https://{HOST}/blob"
    assert env(main("kitty-ai"))["AI_MCP_PUBLIC_URL"]["value"] == f"https://{HOST}/ai/mcp"
    web = env(main("kitty-web"))
    assert web["LEDGER_URL"]["value"] == "http://ledger:8080"
    assert web["AI_URL"]["value"] == "http://ai:8000"
    assert web["AUTH_KEYCLOAK_ISSUER"]["value"] == f"https://{HOST}/auth/realms/kitty"
    pulse = env(main("kitty-pulse"))
    assert pulse["PULSE_LEDGER_GRPC"]["value"] == "ledger:8082"
    assert pulse["PULSE_SMTP_FROM"]["value"] == "Kitty <$(SMTP_FROM)>"


@pytest.mark.parametrize(("chart", "role", "file"), [("kitty-ai", "ai", "ai-db-setup.sql"),
                                                      ("kitty-pulse", "pulse", "pulse-db-setup.sql")])  # fmt: skip
def test_db_setup_runs_before_start(chart, role, file):
    inits = {c["name"]: c for c in pod_spec(deployment(chart))["initContainers"]}
    setup = inits["db-setup"]
    assert setup["image"] == "pgvector/pgvector:pg17"
    assert setup["command"] == ["psql", "-v", f"{role}_password=$({role.upper()}_DB_PASSWORD)", "-f", f"/setup/{file}"]
    e = env(setup)
    assert (e["PGHOST"]["value"], e["PGUSER"]["value"], e["PGDATABASE"]["value"]) == ("postgres", "postgres", "ledger")
    assert list(inits).index("wait") < list(inits).index("db-setup")
    copy = REPO / "deploy" / "charts" / chart / "files" / file
    assert copy.read_bytes() == (REPO / "deploy" / "compose" / file).read_bytes()


@pytest.mark.parametrize(
    ("chart", "deps"),
    [
        ("kitty-ledger", ["postgres:5432", "redis:6379", "redpanda:9092", "pulse:5090"]),
        ("kitty-ai", ["postgres:5432", "redpanda:9092", "azurite:10000"]),
        ("kitty-pulse", ["postgres:5432", "redpanda:9092", "keycloak:8080"]),
        ("kitty-web", ["ledger:8080", "keycloak:8080"]),
    ],
)
def test_waits_for_dependencies(chart, deps):
    wait = next(c for c in pod_spec(deployment(chart))["initContainers"] if c["name"] == "wait")
    script = " ".join(wait["command"])
    assert wait["image"].startswith("busybox:1.")
    for dep in deps:
        assert dep.replace(":", " ") in script, dep


def test_notifications_switch():
    # Off (a rehearsal cluster, CI): pulse sends nothing. Production has them on since the k3s switch.
    off = env(main("kitty-pulse", "--set", "notifications.enabled=false"))
    assert off["PULSE_SMTP_HOST"]["value"] == ""
    assert off["PULSE_FCM_CREDENTIALS"]["value"] == ""
    on = env(main("kitty-pulse"))
    assert on["PULSE_SMTP_HOST"]["value"] == "smtp.gmail.com"
    assert on["PULSE_FCM_CREDENTIALS"]["value"] == ""  # push stays off until a Firebase key is sealed


@pytest.mark.parametrize("chart", KITTY_CHARTS)
def test_images_are_pinned_tags(chart):
    image = main(chart)["image"]
    assert image.startswith(f"ghcr.io/flyinginsectsunpig/{chart}:")
    assert re.fullmatch(r"sha-[0-9a-f]{7}", image.rsplit(":", 1)[1])


@pytest.mark.parametrize("chart", KITTY_CHARTS)
def test_memory_limits_match_compose(chart):
    assert main(chart)["resources"]["limits"]["memory"] == LIMITS[chart]


@pytest.mark.parametrize(("chart", "ports"), [("kitty-ledger", {8080, 8082}), ("kitty-web", {3000}),
                                               ("kitty-ai", {8000}), ("kitty-pulse", {5090})])  # fmt: skip
def test_services_keep_compose_names(chart, ports):
    svc = one(render(chart), "Service", SERVICE[chart])
    assert {p["port"] for p in svc["spec"]["ports"]} == ports
    assert svc["spec"]["selector"] == {"app.kubernetes.io/name": chart}


@pytest.mark.parametrize("chart", KITTY_CHARTS)
def test_otel_env_in_production(chart):
    e = env(main(chart))
    assert e["OTEL_EXPORTER_OTLP_ENDPOINT"]["value"] == "http://otel-collector.observability:4318"
    assert e["OTEL_EXPORTER_OTLP_PROTOCOL"]["value"] == "http/protobuf"
    assert e["OTEL_SERVICE_NAME"]["value"] == SERVICE[chart]
    assert e["OTEL_LOGS_EXPORTER"]["value"] == "none"  # logs reach Grafana once, through the Collector's file_log
    assert e["OTEL_RESOURCE_ATTRIBUTES"]["value"] == "deployment.environment.name=production"


@pytest.mark.parametrize("chart", KITTY_CHARTS)
def test_no_otel_env_without_endpoint(chart):
    assert not OTEL & set(env(main(chart, "--set", "otel.endpoint=")))


def test_ai_uses_the_stable_http_metric_names():
    # FastAPI's instrumentation still defaults to http.server.duration (ms); opted in, it emits
    # http.server.request.duration (s) like the ledger, so one p95 and error-rate query covers both.
    assert env(main("kitty-ai"))["OTEL_SEMCONV_STABILITY_OPT_IN"]["value"] == "http"
