import json
import re

import pytest

from helpers import REPO

TF = REPO / "deploy" / "terraform" / "grafana"
PANELS = ["Expenses per day", "Receipt read success rate", "p95 response time", "Error rate", "Pod memory",
          "Pod restarts", "Last backup", "Certificate days left"]  # fmt: skip


def tf_text() -> dict[str, str]:
    return {p.name: p.read_text(encoding="utf-8") for p in TF.glob("*.tf")}


def rule(name: str) -> str:
    text = tf_text()["alerts.tf"]
    m = re.search(rf'name\s*=\s*"{re.escape(name)}"', text)
    assert m, f"no rule {name}"
    end = text.find("\n  rule {", m.end())
    return text[m.start(): end if end != -1 else len(text)]


@pytest.mark.parametrize(
    ("name", "needles"),
    [
        ("error-rate", ["0.05", ">= 20", "[10m]", 'http_response_status_code=~\\"5..\\"']),
        # Not ready for 10 minutes in a row (a slow start doesn't fire), or a crash loop (2+ restarts in 10 minutes).
        ("pod-unhealthy", ["k8s_container_ready", "k8s_container_restarts", ">= 2", "FOR_10M",
                           'k8s_namespace_name=\\"kitty\\"']),
        ("backup-missing", ["kitty_backup_last_success_seconds", "93600", "NO_DATA_ALERTS"]),
        ("certificate-expiring", ["certmanager_certificate_expiration_timestamp_seconds", "1209600"]),
        ("collector-silent", ["otelcol_exporter_sent_metric_points_total", "[15m]", "NO_DATA_ALERTS"]),
    ],
)
def test_five_alerts_with_spec_thresholds(name, needles):
    body = rule(name)
    for needle in needles:
        if needle == "NO_DATA_ALERTS":  # silence itself is the problem for these two
            assert re.search(r'no_data_state\s*=\s*"Alerting"', body), name
        elif needle == "FOR_10M":
            assert re.search(r'for\s*=\s*"10m"', body), name
        else:
            assert needle in body, (name, needle)


def test_alerts_email_the_owner():
    text = "".join(tf_text().values())
    assert 'resource "grafana_contact_point" "owner"' in text
    assert "addresses = [var.alert_email]" in text
    assert re.search(r'contact_point\s*=\s*grafana_contact_point\.owner\.name', text)


def test_dashboard_has_the_panels():
    dashboard = json.loads((TF / "dashboards" / "kitty.json").read_text(encoding="utf-8"))
    titles = [p["title"] for p in dashboard["panels"]]
    for title in PANELS:
        assert title in titles, title
    # One data-source variable instead of a hard-coded uid, so the file is the same for any stack.
    assert any(v["type"] == "datasource" for v in dashboard["templating"]["list"])
    for p in dashboard["panels"]:
        assert p["datasource"]["uid"] == "${datasource}", p["title"]


def test_no_personal_values_committed():
    ignore = (TF / ".gitignore").read_text(encoding="utf-8").split()
    for pattern in ("terraform.tfvars", "backend.hcl", "*.tfstate*", ".terraform/"):
        assert pattern in ignore, pattern
    for name, text in {**tf_text(), "kitty.json": (TF / "dashboards" / "kitty.json").read_text(encoding="utf-8"),
                       "example": (TF / "terraform.tfvars.example").read_text(encoding="utf-8")}.items():  # fmt: skip
        assert not re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", text), name
        assert "glc_" not in text and "glsa_" not in text, name  # Grafana token prefixes
    variables = tf_text()["variables.tf"]
    for secret in ("grafana_token", "alert_email"):
        block = variables[variables.index(f'variable "{secret}"'):]
        assert "sensitive   = true" in block[: block.index("}")], secret
