# Kitty's Oracle Cloud resources, all within Always Free. Run from the owner's PC, never from CI:
#   terraform init -backend-config=backend.hcl && terraform plan
# A plan that would destroy or replace the server is a bug in this code: never apply it (deploy/k3s/RUNBOOK.md).
terraform {
  required_version = ">= 1.12.0"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "= 9.15.0"
    }
  }
}

# Credentials and the region come from ~/.oci/config (the OCI CLI's own file).
provider "oci" {
  config_file_profile = "DEFAULT"
  region              = var.region
}
