import re

from helpers import REPO

TF = REPO / "deploy" / "terraform" / "oracle"


def tf_text():
    return {p.name: p.read_text(encoding="utf-8") for p in TF.glob("*.tf")}


def block(text, kind, name):
    """The body of `resource "<kind>" "<name>" { … }` (brace-matched)."""
    m = re.search(rf'resource "{kind}" "{name}" \{{', text)
    assert m, f"{kind}.{name} not found"
    depth, i = 1, m.end()
    while depth:
        depth += {"{": 1, "}": -1}.get(text[i], 0)
        i += 1
    return text[m.end():i - 1]


def test_instance_cannot_be_destroyed():
    body = block(tf_text()["instance.tf"], "oci_core_instance", "kitty")
    assert re.search(r"prevent_destroy\s*=\s*true", body)
    ignored = re.search(r"ignore_changes\s*=\s*\[([^\]]*)\]", body, re.S).group(1)
    for attr in ("source_details", "metadata", "create_vnic_details"):
        assert attr in ignored, attr


def test_no_personal_values_committed():
    ignore = (TF / ".gitignore").read_text(encoding="utf-8").split()
    for pattern in ("terraform.tfvars", "*.tfstate*", ".terraform/", "backend.hcl"):
        assert pattern in ignore, pattern
    for name, text in {**tf_text(), "terraform.tfvars.example": (TF / "terraform.tfvars.example").read_text()}.items():
        assert "ocid1." not in text, name
        assert not re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", text), name
        assert "84.12.81.68" not in text, name
        assert "axptcokwl3ud" not in text, name  # the Object Storage namespace


def test_no_upload_link_in_terraform():
    assert not any("oci_objectstorage_preauthrequest" in t for t in tf_text().values())


def test_firewall_opens_only_ssh_http_https():
    body = block(tf_text()["network.tf"], "oci_core_default_security_list", "public")
    ports = sorted(int(p) for p in re.findall(r"\b(?:min|max)\s*=\s*(\d+)", body))
    assert ports == [22, 22, 80, 80, 443, 443]  # min and max of each range


def test_imports_cover_the_existing_resources():
    imports = tf_text()["imports.tf"]
    for target in ("oci_core_instance.kitty", "oci_core_vcn.main", "oci_core_subnet.public",
                   "oci_core_internet_gateway.main", "oci_budget_budget.cost_guard", "oci_budget_alert_rule.cost_guard",
                   "oci_objectstorage_bucket.backups", "oci_objectstorage_object_lifecycle_policy.backups",
                   "oci_identity_policy.backups_lifecycle"):  # fmt: skip
        assert re.search(rf"to\s*=\s*{re.escape(target)}\b", imports), target
