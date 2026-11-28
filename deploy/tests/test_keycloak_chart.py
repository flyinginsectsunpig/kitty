from helpers import REPO, compose, container, env, kinds, one, pod_spec, render

HOST = "kitty-split.duckdns.org"


def deployment():
    return one(render("keycloak"), "Deployment", "keycloak")


def test_env_names_match_compose():
    assert set(env(container(deployment(), "keycloak"))) == set(compose()["services"]["keycloak"]["environment"])


def test_env_values():
    e = env(container(deployment(), "keycloak"))
    assert e["KC_HOSTNAME"]["value"] == f"https://{HOST}/auth"
    assert e["KC_HOSTNAME_ADMIN"]["value"] == "http://localhost:8180/auth"
    assert e["KC_HTTP_RELATIVE_PATH"]["value"] == "/auth"
    assert e["KC_PROXY_HEADERS"]["value"] == "xforwarded"
    assert e["KC_DB_URL"]["value"] == "jdbc:postgresql://postgres:5432/keycloak"
    assert e["KITTY_PUBLIC_URL"]["value"] == f"https://{HOST}"
    assert e["SMTP_HOST"]["value"] == "smtp.gmail.com"
    assert e["SMTP_PORT"]["value"] == "465"
    assert e["GOOGLE_ENABLED"]["value"] == "false"


def test_secrets_come_from_kitty_secrets():
    e = env(container(deployment(), "keycloak"))
    expected = {
        "KC_DB_PASSWORD": "POSTGRES_PASSWORD",
        "KC_BOOTSTRAP_ADMIN_PASSWORD": "KEYCLOAK_ADMIN_PASSWORD",
        "KITTY_WEB_CLIENT_SECRET": "KITTY_WEB_CLIENT_SECRET",
        "PULSE_CLIENT_SECRET": "PULSE_CLIENT_SECRET",
        "KITTY_MCP_CLIENT_SECRET": "KITTY_MCP_CLIENT_SECRET",
        "SMTP_FROM": "SMTP_FROM",
        "SMTP_USER": "SMTP_USER",
        "SMTP_PASSWORD": "SMTP_PASSWORD",
        "GOOGLE_CLIENT_ID": "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET": "GOOGLE_CLIENT_SECRET",
    }
    for name, key in expected.items():
        assert e[name]["valueFrom"]["secretKeyRef"] == {"name": "kitty-secrets", "key": key}, name


def test_imports_realm_on_start():
    c = container(deployment(), "keycloak")
    assert c["args"] == ["start", "--import-realm"]
    mount = next(m for m in c["volumeMounts"] if m["mountPath"] == "/opt/keycloak/data/import/kitty-realm.json")
    volume = next(v for v in pod_spec(deployment())["volumes"] if v["name"] == mount["name"])
    assert volume["configMap"]["name"] == "keycloak-realm"
    assert "kitty-realm.json" in one(render("keycloak"), "ConfigMap", "keycloak-realm")["data"]


def test_realm_is_the_infra_copy():
    copy = REPO / "deploy" / "charts" / "keycloak" / "files" / "kitty-realm.json"
    assert copy.read_bytes() == (REPO / "infra" / "keycloak" / "kitty-realm.json").read_bytes()


def test_waits_for_postgres():
    (init,) = pod_spec(deployment())["initContainers"]
    assert "pg_isready -h postgres -U postgres" in " ".join(init["command"])


def test_not_exposed():
    svc = one(render("keycloak"), "Service", "keycloak")
    assert svc["spec"].get("type", "ClusterIP") == "ClusterIP"
    assert {p["port"] for p in svc["spec"]["ports"]} == {8080}
    for d in kinds(render("keycloak"), "Deployment"):
        for c in pod_spec(d)["containers"]:
            assert all("hostPort" not in p for p in c.get("ports", []))


def test_memory_limit_matches_compose():
    assert container(deployment(), "keycloak")["resources"]["limits"]["memory"] == "1Gi"
