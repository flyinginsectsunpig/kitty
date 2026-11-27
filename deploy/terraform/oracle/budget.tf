# The account is Pay As You Go (that's how the A1 server was obtained), so a US$1 monthly budget emails as soon as
# anything costs money at all: everything Kitty uses must stay within Always Free.

resource "oci_budget_budget" "cost_guard" {
  compartment_id = var.tenancy_ocid
  display_name   = "kitty-cost-guard"
  amount         = 1
  reset_period   = "MONTHLY"
  target_type    = "COMPARTMENT"
  targets        = [var.tenancy_ocid]
}

resource "oci_budget_alert_rule" "cost_guard" {
  budget_id      = oci_budget_budget.cost_guard.id
  display_name   = "any-charge"
  type           = "ACTUAL"
  threshold      = 1
  threshold_type = "PERCENTAGE"
  recipients     = var.budget_alert_email
  message        = "Kitty's Oracle account has started costing money. It should only run Always Free resources: check Billing > Cost Analysis."
}
