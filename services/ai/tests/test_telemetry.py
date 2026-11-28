import pytest
from fastapi import FastAPI
from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from kitty_ai import telemetry

TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
TRACEPARENT = f"00-{TRACE_ID}-00f067aa0ba902b7-01"

# The SDK lets a process set its global providers once: these in-memory ones serve the whole module.
_reader = InMemoryMetricReader()
_spans = InMemorySpanExporter()


@pytest.fixture(scope="module", autouse=True)
def providers():
    metrics.set_meter_provider(MeterProvider(metric_readers=[_reader]))
    tp = TracerProvider()
    tp.add_span_processor(SimpleSpanProcessor(_spans))
    trace.set_tracer_provider(tp)


def points(name: str) -> list:
    data = _reader.get_metrics_data()
    found = []
    for rm in data.resource_metrics if data else []:
        for sm in rm.scope_metrics:
            for m in sm.metrics:
                if m.name == name:
                    found.extend(m.data.data_points)
    return found


def test_no_endpoint_means_no_exporter(monkeypatch):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    assert telemetry.setup_telemetry(FastAPI()) is False


def test_extract_and_inject_round_trip():
    ctx = telemetry.extract_context([("traceparent", TRACEPARENT.encode()), ("not-before", b"1")])
    headers = dict(telemetry.inject_headers(ctx))
    assert headers["traceparent"].decode().split("-")[1] == TRACE_ID


def test_no_header_means_a_new_trace():
    ctx = telemetry.extract_context(None)
    assert trace.get_current_span(ctx).get_span_context().is_valid is False


def test_receipt_outcome_is_counted():
    telemetry.record_receipt("parsed")
    telemetry.record_receipt("rate_limited")
    by_outcome = {dict(p.attributes)["outcome"]: p.value for p in points("kitty.receipts.read")}
    assert by_outcome["parsed"] >= 1 and by_outcome["rate_limited"] >= 1
    assert all(set(p.attributes) == {"outcome"} for p in points("kitty.receipts.read"))  # nothing else as a label


def test_model_calls_are_counted_by_result():
    with telemetry.model_call("sentence"):
        pass
    with pytest.raises(telemetry.RateLimited):
        with telemetry.model_call("sentence"):
            raise telemetry.RateLimited("busy")
    results = {(dict(p.attributes)["kind"], dict(p.attributes)["result"]) for p in points("kitty.model.calls")}
    assert {("sentence", "ok"), ("sentence", "rate_limited")} <= results


def test_read_span_is_child_of_upload():
    with telemetry.consumer_span("receipt.read", [("traceparent", TRACEPARENT.encode())]):
        pass
    span = next(s for s in _spans.get_finished_spans() if s.name == "receipt.read")
    assert format(span.context.trace_id, "032x") == TRACE_ID
    assert span.kind == trace.SpanKind.CONSUMER
