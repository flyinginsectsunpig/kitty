import yaml

from helpers import REPO

K3S = REPO / "deploy" / "k3s"


def test_alongside_compose_keeps_servicelb_off():
    # ServiceLB's hostPorts are iptables DNAT rules, not bound ports: running it next to Caddy would take 80/443 away
    # from the live site the moment k3s starts. Until the switch, Traefik is reached on its NodePorts only.
    cfg = yaml.safe_load((K3S / "config-alongside-compose.yaml").read_text(encoding="utf-8"))
    assert "servicelb" in cfg["disable"]
    assert cfg["write-kubeconfig-mode"] == "0600"


def test_normal_config_serves_80_and_443():
    cfg = yaml.safe_load((K3S / "config.yaml").read_text(encoding="utf-8"))
    assert "servicelb" not in (cfg.get("disable") or [])
    assert cfg["write-kubeconfig-mode"] == "0600"


def test_runbook_way_back_removes_k3s_rules():
    runbook = (K3S / "RUNBOOK.md").read_text(encoding="utf-8")
    assert "k3s-killall.sh" in runbook  # scaling Traefik down would leave ServiceLB's rules in place
    assert "scale deployment traefik" not in runbook
    assert "config-alongside-compose.yaml" in runbook
