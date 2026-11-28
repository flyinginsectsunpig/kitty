# Every Kitty alert emails the owner, grouped per alert, at most every four hours while it keeps firing.
resource "grafana_contact_point" "owner" {
  name = "kitty-owner"

  email {
    addresses = [var.alert_email]
    subject   = "Kitty: {{ .CommonLabels.alertname }} {{ .Status }}"
  }
}

resource "grafana_notification_policy" "kitty" {
  contact_point   = grafana_contact_point.owner.name
  group_by        = ["alertname"]
  group_wait      = "30s"
  group_interval  = "5m"
  repeat_interval = "4h"
}
