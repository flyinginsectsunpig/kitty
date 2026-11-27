# Values that identify the owner's account live in the git-ignored terraform.tfvars (see terraform.tfvars.example).

variable "tenancy_ocid" {
  type        = string
  description = "The tenancy (root compartment) OCID; the IAM policy and the budget live here."
}

variable "compartment_ocid" {
  type        = string
  description = "The compartment holding the server, network and buckets (Kitty uses the root compartment)."
}

variable "region" {
  type    = string
  default = "af-johannesburg-1"
}

variable "object_storage_namespace" {
  type        = string
  description = "The tenancy's Object Storage namespace (oci os ns get)."
}

variable "budget_alert_email" {
  type        = string
  description = "Where the cost-guard budget sends its alert."
}

variable "availability_domain" {
  type        = string
  description = "The server's availability domain name (e.g. XXXX:AF-JOHANNESBURG-1-AD-1)."
}

variable "ubuntu_image_ocid" {
  type        = string
  description = "The image the server was created from. Ignored after creation; only needed to describe it."
}

variable "ssh_public_key" {
  type        = string
  description = "The server's SSH public key (ignored after creation)."
}

# OCIDs of the resources that already exist, for the import blocks in imports.tf.
variable "existing" {
  type = object({
    instance          = string
    vcn               = string
    subnet            = string
    internet_gateway  = string
    budget            = string
    budget_alert_rule = string
    lifecycle_policy  = string
  })
}
