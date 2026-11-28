# Kitty's Grafana Cloud dashboard and alerts (phase 5b). Run from the owner's PC, never from CI:
#   terraform init -backend-config=backend.hcl && terraform plan
# The stack, its tokens and the OTLP write token are created by hand in Grafana Cloud (deploy/k3s/RUNBOOK.md).
terraform {
  required_version = ">= 1.12.0"
  required_providers {
    grafana = {
      source  = "grafana/grafana"
      version = "= 4.55.0"
    }
  }
}

provider "grafana" {
  url  = var.grafana_url
  auth = var.grafana_token
}
