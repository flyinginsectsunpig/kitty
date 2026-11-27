# The server: Always Free A1, 2 OCPU / 12 GB (the whole free allowance since June 2026). It took ~3,250 attempts to
# get, so Terraform must never replace or destroy it: prevent_destroy refuses any plan that would, and the attributes
# that only matter at creation (or that Oracle changes on its own) are ignored.

resource "oci_core_instance" "kitty" {
  compartment_id      = var.compartment_ocid
  availability_domain = var.availability_domain
  display_name        = "kitty"
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = 2
    memory_in_gbs = 12
  }

  source_details {
    source_type             = "image"
    source_id               = var.ubuntu_image_ocid
    boot_volume_size_in_gbs = 100
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = true # ephemeral: survives reboots; only changes if the instance is stopped
  }

  metadata = {
    ssh_authorized_keys = var.ssh_public_key
  }

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [source_details, metadata, create_vnic_details, defined_tags, freeform_tags]
  }
}
