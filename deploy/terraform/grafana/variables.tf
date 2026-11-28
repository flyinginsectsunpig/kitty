# Set in the git-ignored terraform.tfvars (see terraform.tfvars.example).

variable "grafana_url" {
  type        = string
  description = "The Grafana Cloud stack's URL, e.g. https://<stack>.grafana.net."
}

variable "grafana_token" {
  type        = string
  sensitive   = true
  description = "A service-account token with Editor on the stack (Administration > Service accounts)."
}

variable "alert_email" {
  type        = string
  sensitive   = true
  description = "Where alerts are emailed."
}

variable "prometheus_datasource_uid" {
  type        = string
  description = "The stack's Prometheus (Mimir) data source uid, e.g. grafanacloud-prom."
  default     = "grafanacloud-prom"
}
