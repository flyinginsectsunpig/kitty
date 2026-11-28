# Kitty's five alerts (design §3), checked every minute. Each rule: query A (Prometheus) → threshold C.
# Metric names are OpenTelemetry's as Grafana Cloud stores them: dots become underscores, counters gain _total,
# units become suffixes (kitty.backup.last_success, unit s → kitty_backup_last_success_seconds).

locals {
  prometheus = { type = "prometheus", uid = var.prometheus_datasource_uid }
  expression = { type = "__expr__", uid = "__expr__" }
}

resource "grafana_rule_group" "kitty" {
  name             = "kitty"
  folder_uid       = grafana_folder.kitty.uid
  interval_seconds = 60

  # More than 5% of a service's requests answered 5xx over 10 minutes, counted only with at least 20 requests.
  rule {
    name           = "error-rate"
    condition      = "C"
    for            = "0s"
    no_data_state  = "OK"
    exec_err_state = "Error"
    annotations = {
      summary = "{{ $labels.job }}: more than 5% of requests failed (5xx) in the last 10 minutes."
    }
    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId = "A", instant = true, datasource = local.prometheus
        expr  = "(sum by (job) (rate(http_server_request_duration_seconds_count{http_response_status_code=~\"5..\"}[10m])) / sum by (job) (rate(http_server_request_duration_seconds_count[10m]))) and on (job) (sum by (job) (increase(http_server_request_duration_seconds_count[10m])) >= 20)"
      })
    }
    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        refId      = "C", type = "threshold", expression = "A", datasource = local.expression
        conditions = [{ evaluator = { type = "gt", params = [0.05] } }]
      })
    }
  }

  # A Kitty pod not ready for 10 minutes in a row (stuck starting, failing probes), or crash-looping (2+ restarts in
  # 10 minutes, which the readiness check alone misses: a crashing pod is briefly ready between restarts).
  # A slow start shorter than 10 minutes, or a single restart, doesn't fire.
  rule {
    name           = "pod-unhealthy"
    condition      = "C"
    for            = "10m"
    no_data_state  = "OK"
    exec_err_state = "Error"
    annotations = {
      summary = "{{ $labels.k8s_pod_name }} has been unready or restarting for 10 minutes (kubectl -n kitty describe pod)."
    }
    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId = "A", instant = true, datasource = local.prometheus
        expr  = "min by (k8s_pod_name) (k8s_container_ready{k8s_namespace_name=\"kitty\"})"
      })
    }
    data {
      ref_id         = "B"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId = "B", instant = true, datasource = local.prometheus
        expr  = "max by (k8s_pod_name) (delta(k8s_container_restarts{k8s_namespace_name=\"kitty\"}[10m]))"
      })
    }
    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        refId = "C", type = "math", expression = "$A < 1 || $B >= 2", datasource = local.expression
      })
    }
  }

  # No successful nightly backup for 26 hours (93,600 s), or none reported at all.
  rule {
    name           = "backup-missing"
    condition      = "C"
    for            = "0s"
    no_data_state  = "Alerting"
    exec_err_state = "Error"
    annotations = {
      summary = "No successful Kitty backup for over 26 hours: check ~/kitty-backups/backup.log on the server."
    }
    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId = "A", instant = true, datasource = local.prometheus
        expr  = "time() - max(max_over_time(kitty_backup_last_success_seconds[2d]))"
      })
    }
    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        refId      = "C", type = "threshold", expression = "A", datasource = local.expression
        conditions = [{ evaluator = { type = "gt", params = [93600] } }]
      })
    }
  }

  # The HTTPS certificate expires within 14 days (1,209,600 s): cert-manager's renewal has failed.
  rule {
    name           = "certificate-expiring"
    condition      = "C"
    for            = "0s"
    no_data_state  = "OK"
    exec_err_state = "Error"
    annotations = {
      summary = "The HTTPS certificate expires within 14 days: renewal has failed (kubectl -n kitty describe certificate kitty-tls)."
    }
    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 600
        to   = 0
      }
      model = jsonencode({
        refId = "A", instant = true, datasource = local.prometheus
        expr  = "min(certmanager_certificate_expiration_timestamp_seconds) - time()"
      })
    }
    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        refId      = "C", type = "threshold", expression = "A", datasource = local.expression
        conditions = [{ evaluator = { type = "lt", params = [1209600] } }]
      })
    }
  }

  # The collector sent nothing for 15 minutes: silence must never look like health.
  rule {
    name           = "collector-silent"
    condition      = "C"
    for            = "0s"
    no_data_state  = "Alerting"
    exec_err_state = "Alerting"
    annotations = {
      summary = "No telemetry from Kitty's collector for 15 minutes: kubectl -n observability get pods."
    }
    data {
      ref_id         = "A"
      datasource_uid = var.prometheus_datasource_uid
      relative_time_range {
        from = 900
        to   = 0
      }
      model = jsonencode({
        refId = "A", instant = true, datasource = local.prometheus
        expr  = "sum(rate(otelcol_exporter_sent_metric_points_total[15m]))"
      })
    }
    data {
      ref_id         = "C"
      datasource_uid = "__expr__"
      relative_time_range {
        from = 0
        to   = 0
      }
      model = jsonencode({
        refId      = "C", type = "threshold", expression = "A", datasource = local.expression
        conditions = [{ evaluator = { type = "lt", params = [0.001] } }]
      })
    }
  }
}
