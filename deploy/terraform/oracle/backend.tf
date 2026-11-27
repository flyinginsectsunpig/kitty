# State lives in its own private Object Storage bucket (created once by hand: deploy/k3s/RUNBOOK.md), never in git.
# The bucket's namespace goes in the git-ignored backend.hcl:  namespace = "<object storage namespace>"
terraform {
  backend "oci" {
    bucket = "kitty-tfstate"
    key    = "oracle/terraform.tfstate"
  }
}
