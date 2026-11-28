import pytest

from helpers import REPO, compose, container, one, pod_spec, render

LIMITS = {"postgres": "1Gi", "redis": "64Mi", "redpanda": "1500Mi", "azurite": "256Mi"}
STATEFUL = {"postgres": "10Gi", "redpanda": "5Gi", "azurite": "5Gi"}
WORKLOAD = {"postgres": "StatefulSet", "redis": "Deployment", "redpanda": "StatefulSet", "azurite": "StatefulSet"}


def workload(chart):
    return one(render(chart), WORKLOAD[chart], chart)


@pytest.mark.parametrize("chart", LIMITS)
def test_images_match_compose(chart):
    assert container(workload(chart))["image"] == compose()["services"][chart]["image"]


@pytest.mark.parametrize("chart", LIMITS)
def test_memory_limits_match_compose(chart):
    assert container(workload(chart))["resources"]["limits"]["memory"] == LIMITS[chart]


@pytest.mark.parametrize("chart", STATEFUL)
def test_stateful_pieces_have_kept_volumes(chart):
    (claim,) = workload(chart)["spec"]["volumeClaimTemplates"]
    assert claim["spec"]["storageClassName"] == "local-path"
    assert claim["spec"]["resources"]["requests"]["storage"] == STATEFUL[chart]
    assert claim["metadata"]["annotations"]["helm.sh/resource-policy"] == "keep"


@pytest.mark.parametrize("chart", ["redis", "redpanda", "azurite"])
def test_commands_match_compose(chart):
    # Compose's `command` replaces the image's CMD, which is Kubernetes' `args`. Service names equal Compose's, so
    # redpanda's advertised addresses carry over unchanged.
    assert container(workload(chart))["args"] == compose()["services"][chart]["command"]


@pytest.mark.parametrize(
    ("chart", "probe"),
    [
        ("postgres", ["pg_isready", "-U", "postgres", "-d", "ledger"]),
        ("redis", ["redis-cli", "ping"]),
        ("redpanda", ["sh", "-c", "rpk cluster health | grep -E 'Healthy:.+true'"]),
    ],
)
def test_probes(chart, probe):
    assert container(workload(chart))["readinessProbe"]["exec"]["command"] == probe


def test_postgres_init_sql_is_the_compose_copy():
    copy = REPO / "deploy" / "charts" / "postgres" / "files" / "10-keycloak.sql"
    assert copy.read_bytes() == (REPO / "deploy" / "compose" / "postgres-init.sql").read_bytes()


def test_postgres_settings():
    c = container(workload("postgres"))
    env = {e["name"]: e for e in c["env"]}
    assert env["POSTGRES_DB"]["value"] == "ledger"
    assert env["POSTGRES_USER"]["value"] == "postgres"
    assert env["POSTGRES_PASSWORD"]["valueFrom"]["secretKeyRef"] == {"name": "kitty-secrets", "key": "POSTGRES_PASSWORD"}
    # The data directory sits below the mount point, so the volume's lost+found never confuses initdb.
    assert env["PGDATA"]["value"].startswith("/var/lib/postgresql/data/")
    mounts = {m["mountPath"]: m for m in c["volumeMounts"]}
    assert mounts["/docker-entrypoint-initdb.d/10-keycloak.sql"]["subPath"] == "10-keycloak.sql"


def test_azurite_account_key_comes_from_the_secret():
    env = [(e["name"], e) for e in container(workload("azurite"))["env"]]
    names = [n for n, _ in env]
    # The key must be defined before the variable that refers to it, or Kubernetes leaves $(…) as text.
    assert names.index("BLOB_ACCOUNT_KEY") < names.index("AZURITE_ACCOUNTS")
    assert dict(env)["AZURITE_ACCOUNTS"]["value"] == "kitty:$(BLOB_ACCOUNT_KEY)"
    assert dict(env)["BLOB_ACCOUNT_KEY"]["valueFrom"]["secretKeyRef"] == {"name": "kitty-secrets", "key": "BLOB_ACCOUNT_KEY"}


@pytest.mark.parametrize(
    ("chart", "ports"),
    [("postgres", {5432}), ("redis", {6379}), ("redpanda", {9092, 8081, 33145}), ("azurite", {10000})],
)
def test_services_keep_compose_names(chart, ports):
    svc = one(render(chart), "Service", chart)
    assert {p["port"] for p in svc["spec"]["ports"]} == ports
    assert svc["spec"]["selector"] == {"app.kubernetes.io/name": chart}
    assert pod_spec(workload(chart)) is not None
    assert workload(chart)["spec"]["template"]["metadata"]["labels"]["app.kubernetes.io/name"] == chart


def test_azurite_does_not_log_signed_urls():
    # Its access log would print each upload's SAS URL, whose sig= is a write token.
    assert "--silent" in container(workload("azurite"))["args"]
