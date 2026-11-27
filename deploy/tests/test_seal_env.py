import base64

import yaml

from helpers import EDGE_CHART, KITTY_CHARTS, SUPPORT_CHARTS, render, run_script

KEYS = ["POSTGRES_PASSWORD", "KEYCLOAK_ADMIN_PASSWORD", "AUTH_SECRET", "KITTY_WEB_CLIENT_SECRET", "BLOB_ACCOUNT_KEY",
        "AI_DB_PASSWORD", "PULSE_DB_PASSWORD", "PULSE_CLIENT_SECRET", "KITTY_MCP_CLIENT_SECRET", "GEMINI_API_KEY",
        "SMTP_USER", "SMTP_FROM", "SMTP_PASSWORD", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]  # fmt: skip
SEAL = "deploy/k3s/seal-env.sh"


def env_file(tmp_path, drop=(), extra=""):
    lines = [f"{k}=dummy-{k.lower()}=" for k in KEYS if k not in drop and not k.startswith("GOOGLE")]
    lines += ["KITTY_HOST=example.test", "SMTP_HOST=smtp.example.test", "KITTY_TAG=latest", "GOOGLE_ENABLED=false"]
    path = tmp_path / ".env"
    path.write_text("\r\n".join(lines) + "\r\n" + extra, encoding="utf-8")  # Windows line endings must not leak in
    return path


def test_secret_has_exactly_the_listed_keys(tmp_path):
    result = run_script(SEAL, env_file(tmp_path), "--plain")
    assert result.returncode == 0, result.stderr
    secret = yaml.safe_load(result.stdout)
    assert (secret["kind"], secret["metadata"]["name"], secret["metadata"]["namespace"]) == (
        "Secret", "kitty-secrets", "kitty")
    assert set(secret["data"]) == set(KEYS)
    decoded = {k: base64.b64decode(v).decode() for k, v in secret["data"].items()}
    assert decoded["AUTH_SECRET"] == "dummy-auth_secret="  # everything after the first '=' (base64 values end in '=')
    assert decoded["GOOGLE_CLIENT_ID"] == "unset"  # optional, Compose's default
    assert not any("\r" in v for v in decoded.values())


def test_missing_key_is_refused_by_name(tmp_path):
    result = run_script(SEAL, env_file(tmp_path, drop={"AUTH_SECRET"}), "--plain")
    assert result.returncode == 2
    assert "AUTH_SECRET" in result.stderr
    assert "dummy" not in result.stdout + result.stderr


def test_empty_key_is_refused(tmp_path):
    result = run_script(SEAL, env_file(tmp_path, drop={"GEMINI_API_KEY"}, extra="GEMINI_API_KEY=\n"), "--plain")
    assert result.returncode == 2
    assert "GEMINI_API_KEY" in result.stderr


def test_every_secret_reference_is_provided():
    referenced = set()
    for chart in KITTY_CHARTS + SUPPORT_CHARTS + [EDGE_CHART]:
        text = yaml.safe_dump_all(render(chart))
        for doc in yaml.safe_load_all(text):
            _collect(doc, referenced)
    assert referenced <= set(KEYS), sorted(referenced - set(KEYS))
    assert set(KEYS) <= referenced, sorted(set(KEYS) - referenced)


def _collect(node, found):
    if isinstance(node, dict):
        ref = node.get("secretKeyRef")
        if isinstance(ref, dict) and ref.get("name") == "kitty-secrets":
            found.add(ref["key"])
        for v in node.values():
            _collect(v, found)
    elif isinstance(node, list):
        for v in node:
            _collect(v, found)
