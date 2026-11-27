import re
import subprocess

import pytest
import yaml

from helpers import EDGE_CHART, KITTY_CHARTS, REPO, SUPPORT_CHARTS, kinds

CHARTS = KITTY_CHARTS + SUPPORT_CHARTS + [EDGE_CHART]
STATEFUL = ["postgres", "redpanda", "azurite"]
FINALIZER = "resources-finalizer.argocd.argoproj.io"


def apps(revision="test-rev"):
    out = subprocess.run(["helm", "template", "kitty-apps", str(REPO / "deploy" / "apps"), "--set", f"revision={revision}"],
                         check=True, capture_output=True, text=True).stdout  # fmt: skip
    return {d["metadata"]["name"]: d for d in kinds([d for d in yaml.safe_load_all(out) if d], "Application")}


def test_every_chart_has_an_application():
    found = apps()
    for chart in CHARTS:
        src = found[chart]["spec"]["source"]
        assert src["path"] == f"deploy/charts/{chart}"
        (values,) = src["helm"]["valueFiles"]
        assert (REPO / src["path"] / values).resolve() == (REPO / "deploy" / "values" / "production" / f"{chart}.yaml")
        assert (REPO / "deploy" / "values" / "production" / f"{chart}.yaml").is_file()
        assert found[chart]["spec"]["destination"]["namespace"] == "kitty"


def test_platform_and_secrets_applications():
    found = apps()
    assert found["cert-manager"]["spec"]["source"]["chart"] == "cert-manager"
    assert found["sealed-secrets"]["spec"]["destination"]["namespace"] == "kube-system"
    # kubeseal finds the controller by this name by default.
    assert found["sealed-secrets"]["spec"]["source"]["helm"]["releaseName"] == "sealed-secrets-controller"
    assert found["kitty-secrets"]["spec"]["source"]["path"] == "deploy/secrets/production"


@pytest.mark.parametrize("chart", CHARTS + ["kitty-secrets"])
def test_sync_is_automatic_with_retries(chart):
    policy = apps()[chart]["spec"]["syncPolicy"]
    assert policy["automated"] == {"prune": True, "selfHeal": True}
    assert policy["retry"]["limit"] >= 5


@pytest.mark.parametrize("chart", STATEFUL)
def test_stateful_volumes_are_kept(chart):
    # Removing an Application from git prunes the Application object only: without Argo CD's resources finalizer its
    # resources stay, and the StatefulSet's claims are never Helm- or Argo-owned anyway (retention policy Retain).
    app = apps()[chart]
    assert FINALIZER not in app["metadata"].get("finalizers", [])
    text = (REPO / "deploy" / "charts" / chart / "templates" / "statefulset.yaml").read_text(encoding="utf-8")
    assert "helm.sh/resource-policy: keep" in text
    assert "whenDeleted: Retain" in text


def test_versions_are_pinned():
    for name, app in apps().items():
        src = app["spec"]["source"]
        if src["repoURL"].startswith("https://github.com/flyinginsectsunpig/"):
            continue
        assert re.fullmatch(r"v?\d+\.\d+\.\d+|helm-v\d+\.\d+\.\d+", src["targetRevision"]), name


def test_revision_is_a_parameter():
    found = apps("some-branch")
    ours = [a for a in found.values() if a["spec"]["source"]["repoURL"].startswith("https://github.com/flyinginsectsunpig/")]
    assert ours and all(a["spec"]["source"]["targetRevision"] == "some-branch" for a in ours)
    root = (REPO / "deploy" / "k3s" / "root-app.yaml").read_text(encoding="utf-8")
    assert "targetRevision: REVISION" in root
    for f in (REPO / "deploy" / "apps").rglob("*.yaml"):
        assert not re.search(r"targetRevision:\s*(main|feat/)", f.read_text(encoding="utf-8")), f
    result = subprocess.run(["helm", "template", "x", str(REPO / "deploy" / "apps")], capture_output=True, text=True)
    assert result.returncode != 0 and "revision" in result.stderr  # no default: bootstrap.sh must say which


def test_bootstrap_pins_argo_cd():
    text = (REPO / "deploy" / "k3s" / "bootstrap.sh").read_text(encoding="utf-8")
    assert re.search(r"argo/argo-cd --version \d+\.\d+\.\d+", text)
    assert "deploy/platform/argocd-values.yaml" in text
    values = yaml.safe_load((REPO / "deploy" / "platform" / "argocd-values.yaml").read_text(encoding="utf-8"))
    assert values["dex"]["enabled"] is False
    assert values["notifications"]["enabled"] is False
    assert values["server"]["service"]["type"] == "ClusterIP"
