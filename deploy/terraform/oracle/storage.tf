# Nightly backups (deploy/compose/backup.sh) land here, uploaded through a write-only pre-authenticated link that is
# deliberately NOT in Terraform: its URL would sit in the state. Copies older than 30 days are deleted by Object
# Storage itself (which needs the IAM policy in iam.tf).

resource "oci_objectstorage_bucket" "backups" {
  compartment_id = var.compartment_ocid
  namespace      = var.object_storage_namespace
  name           = "kitty-backups"
  access_type    = "NoPublicAccess"
  storage_tier   = "Standard"
}

resource "oci_objectstorage_object_lifecycle_policy" "backups" {
  namespace = var.object_storage_namespace
  bucket    = oci_objectstorage_bucket.backups.name

  rules {
    name        = "delete-after-30-days"
    action      = "DELETE"
    is_enabled  = true
    time_amount = 30
    time_unit   = "DAYS"
    target      = "objects"

    object_name_filter {
      inclusion_prefixes = ["kitty-"]
    }
  }

  depends_on = [oci_identity_policy.backups_lifecycle]
}
