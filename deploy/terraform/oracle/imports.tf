# Everything here existed before Terraform: these blocks adopt it into the state on the first apply (which creates and
# changes nothing when the plan says "0 to add, 0 to change, 0 to destroy").

import {
  to = oci_core_instance.kitty
  id = var.existing.instance
}

import {
  to = oci_core_vcn.main
  id = var.existing.vcn
}

import {
  to = oci_core_subnet.public
  id = var.existing.subnet
}

import {
  to = oci_core_internet_gateway.main
  id = var.existing.internet_gateway
}

import {
  to = oci_core_route_table.main
  id = var.existing.route_table
}

import {
  to = oci_core_security_list.public
  id = var.existing.security_list
}

import {
  to = oci_budget_budget.cost_guard
  id = var.existing.budget
}

import {
  to = oci_budget_alert_rule.cost_guard
  id = "budgets/${var.existing.budget}/alertRules/${var.existing.budget_alert_rule}"
}

import {
  to = oci_objectstorage_bucket.backups
  id = "n/${var.object_storage_namespace}/b/kitty-backups"
}

import {
  to = oci_objectstorage_object_lifecycle_policy.backups
  id = "n/${var.object_storage_namespace}/b/kitty-backups/l"
}

import {
  to = oci_identity_policy.backups_lifecycle
  id = var.existing.lifecycle_policy
}
