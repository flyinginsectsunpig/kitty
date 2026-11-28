resource "grafana_folder" "kitty" {
  title = "Kitty"
  uid   = "kitty"
}

# One dashboard, its panels in dashboards/kitty.json (data source chosen by a variable, so the file fits any stack).
resource "grafana_dashboard" "kitty" {
  folder      = grafana_folder.kitty.uid
  config_json = file("${path.module}/dashboards/kitty.json")
}
