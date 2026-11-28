# State in the same private Object Storage bucket as the Oracle resources, under its own key; never in git.
# The bucket's namespace goes in the git-ignored backend.hcl:  namespace = "<object storage namespace>"
terraform {
  backend "oci" {
    bucket = "kitty-tfstate"
    key    = "grafana/terraform.tfstate"
  }
}
