from helpers import container, kinds, one, render

HOST = "kitty-split.duckdns.org"


def routes(entrypoint="websecure", *extra):
    docs = render("kitty-edge", *extra)
    (ir,) = [d for d in kinds(docs, "IngressRoute") if d["spec"]["entryPoints"] == [entrypoint]]
    return ir["spec"]["routes"]


def route(match, *extra):
    found = [r for r in routes("websecure", *extra) if r["match"] == match]
    assert len(found) == 1, f"no single route matching {match!r}"
    return found[0]


def backend(r):
    (svc,) = r["services"]
    return f"{svc['name']}:{svc['port']}"


def middlewares(r):
    return [m["name"] for m in r.get("middlewares", [])]


def middleware(name):
    return one(render("kitty-edge"), "Middleware", name)["spec"]


KEYCLOAK = ("(Path(`/auth/realms/kitty`) || PathPrefix(`/auth/realms/kitty/`) || PathPrefix(`/auth/resources/`))"
            " && !PathRegexp(`;`)")  # fmt: skip


def test_keycloak_allowlist():
    allow = route(KEYCLOAK)
    deny = route("PathPrefix(`/auth`)")
    assert backend(allow) == "keycloak:8080"
    assert backend(deny) == "edge-deny:8080"
    assert allow["priority"] > deny["priority"]


def test_web_auth_routes_before_ledger():
    auth = route("PathPrefix(`/api/auth/`)")
    api = route("PathPrefix(`/api`)")
    assert backend(auth) == "web:3000"
    assert backend(api) == "ledger:8080"
    assert auth["priority"] > api["priority"]
    assert "strip-api" in middlewares(api)
    assert middleware("strip-api") == {"stripPrefix": {"prefixes": ["/api"]}}


def test_blob_is_put_only():
    put = route("PathPrefix(`/blob/`) && Method(`PUT`)")
    other = route("PathPrefix(`/blob`)")
    assert backend(put) == "azurite:10000"
    assert backend(other) == "edge-deny:8080"
    assert put["priority"] > other["priority"]
    assert {"strip-blob", "blob-size"} <= set(middlewares(put))
    assert middleware("strip-blob") == {"stripPrefix": {"prefixes": ["/blob"]}}
    assert middleware("blob-size") == {"buffering": {"maxRequestBodyBytes": 11534336}}


def test_mcp_metadata_and_ai():
    meta = route("PathPrefix(`/.well-known/oauth-protected-resource`)")
    ai = route("PathPrefix(`/ai/`)")
    assert backend(meta) == backend(ai) == "ai:8000"
    assert not any(m.startswith("strip") for m in middlewares(meta))
    assert "strip-ai" in middlewares(ai)
    assert middleware("strip-ai") == {"stripPrefix": {"prefixes": ["/ai"]}}


def test_default_goes_to_web():
    default = route("PathPrefix(`/`)")
    assert backend(default) == "web:3000"
    assert default["priority"] == min(r["priority"] for r in routes())


def test_priorities_are_explicit_and_distinct():
    ps = [r["priority"] for r in routes()]
    assert all(isinstance(p, int) for p in ps)
    assert len(set(ps)) == len(ps)


def test_headers_on_every_route():
    for r in routes():
        assert {"security-headers", "compress"} <= set(middlewares(r)), r["match"]
    h = middleware("security-headers")["headers"]
    assert h["stsSeconds"] == 31536000
    assert h["contentTypeNosniff"] is True
    assert h["referrerPolicy"] == "strict-origin-when-cross-origin"
    assert h["customResponseHeaders"] == {"Server": ""}


def test_http_redirects_except_acme():
    (r,) = routes("web")
    assert r["match"] == "PathPrefix(`/`)"
    assert r["priority"] == 1  # below cert-manager's challenge Ingress, so challenges are answered over plain HTTP
    assert middleware("redirect-https") == {"redirectScheme": {"scheme": "https", "permanent": True}}
    assert "redirect-https" in middlewares(r)


def test_tls():
    docs = render("kitty-edge")
    issuer = one(docs, "ClusterIssuer", "letsencrypt")["spec"]["acme"]
    assert issuer["server"] == "https://acme-v02.api.letsencrypt.org/directory"
    assert "email" not in issuer  # the issuer is public in git
    assert issuer["solvers"] == [{"http01": {"ingress": {"ingressClassName": "traefik"}}}]
    cert = one(docs, "Certificate", "kitty-tls")["spec"]
    assert cert["dnsNames"] == [HOST]
    assert cert["issuerRef"] == {"kind": "ClusterIssuer", "name": "letsencrypt"}
    ir = [d for d in kinds(docs, "IngressRoute") if d["spec"]["entryPoints"] == ["websecure"]][0]
    assert ir["spec"]["tls"] == {"secretName": "kitty-tls"}

    ci = render("kitty-edge", "--set", "tls.selfSigned=true")
    assert one(ci, "ClusterIssuer", "selfsigned")["spec"] == {"selfSigned": {}}
    assert one(ci, "Certificate", "kitty-tls")["spec"]["issuerRef"]["name"] == "selfsigned"
    assert not [d for d in kinds(ci, "ClusterIssuer") if d["metadata"]["name"] == "letsencrypt"]


def test_coredns_rewrite():
    cm = one(render("kitty-edge"), "ConfigMap", "coredns-custom")
    assert cm["metadata"]["namespace"] == "kube-system"
    assert cm["data"]["kitty.override"].strip() == f"rewrite name exact {HOST} traefik.kube-system.svc.cluster.local"


def test_traefik_config():
    hcc = one(render("kitty-edge"), "HelmChartConfig", "traefik")
    assert hcc["metadata"]["namespace"] == "kube-system"
    import yaml

    v = yaml.safe_load(hcc["spec"]["valuesContent"])
    assert v["ports"]["web"]["nodePort"] == 30080
    assert v["ports"]["websecure"]["nodePort"] == 30443
    assert v["service"]["spec"]["externalTrafficPolicy"] == "Local"
    # Traefik chart 41.6 (k3s v1.37) reads the access log from top-level accessLog; logs.access is silently ignored.
    assert v["accessLog"]["enabled"] is True
    assert "logs" not in v
    # Prometheus metrics on the "metrics" entrypoint, port 9100: the collector scrapes them (phase 5b).
    assert v["metrics"]["prometheus"]["entryPoint"] == "metrics"
    assert v["ports"]["metrics"]["port"] == 9100


def test_deny_backend():
    docs = render("kitty-edge")
    deny = one(docs, "Deployment", "edge-deny")
    assert container(deny)["image"] == "caddy:2.11.9-alpine"
    assert "respond 404" in one(docs, "ConfigMap", "edge-deny")["data"]["Caddyfile"]
    assert {p["port"] for p in one(docs, "Service", "edge-deny")["spec"]["ports"]} == {8080}
