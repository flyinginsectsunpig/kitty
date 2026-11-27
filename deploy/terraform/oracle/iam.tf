# Object Storage needs permission to delete old backups for the lifecycle rule; this allows it for kitty-backups only.

resource "oci_identity_policy" "backups_lifecycle" {
  compartment_id = var.tenancy_ocid
  name           = "kitty-backups-lifecycle"
  description    = "Lets Object Storage delete Kitty backups older than 30 days (lifecycle rule on kitty-backups only)"
  statements = [
    "Allow service objectstorage-${var.region} to manage object-family in tenancy where target.bucket.name='kitty-backups'",
  ]
}
