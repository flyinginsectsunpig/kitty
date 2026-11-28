"""OpenTelemetry for the ai service (phase 5b).

Configured only by the standard OTEL_* variables: without OTEL_EXPORTER_OTLP_ENDPOINT nothing is exported (tests,
local runs without Aspire). Production sends to the cluster's collector, which scrubs before anything leaves the
server. Exports are batched in the background and never block or fail a request.

Counters (no user or group ids as labels):
  kitty.receipts.read{outcome}       parsed, or the ScanFailure reason in lower case (unreadable, rate_limited, ...)
  kitty.sentences.parsed{outcome}    ok, unavailable, unclear
  kitty.model.calls{kind,result}     kind receipt|sentence|ask, result ok|rate_limited|error

Kafka carries W3C trace context in message headers (traceparent), so a receipt's read joins its upload's trace.
"""

import logging
import os
from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import FastAPI
from opentelemetry import metrics, trace
from opentelemetry.context import Context
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

from kitty_ai.receipts.extract import RateLimited

__all__ = ["RateLimited", "consumer_span", "extract_context", "inject_headers", "model_call", "record_receipt",
           "record_sentence", "setup_telemetry", "tracer"]  # fmt: skip

log = logging.getLogger(__name__)
_propagator = TraceContextTextMapPropagator()
_meter = metrics.get_meter("kitty_ai")
tracer = trace.get_tracer("kitty_ai")

_receipts_read = _meter.create_counter("kitty.receipts.read", description="Receipts read, by outcome")
_sentences_parsed = _meter.create_counter("kitty.sentences.parsed", description="Typed sentences, by outcome")
_model_calls = _meter.create_counter("kitty.model.calls", description="Model requests, by feature and result")


def setup_telemetry(app: FastAPI) -> bool:
    """Starts exporting when OTEL_EXPORTER_OTLP_ENDPOINT is set; returns whether it did."""
    if not os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        return False
    # Imported here so a run without telemetry never loads the SDK's exporters.
    from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
    from opentelemetry.instrumentation.psycopg import PsycopgInstrumentor
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    resource = Resource.create()  # OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES
    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(tracer_provider)
    metrics.set_meter_provider(
        MeterProvider(resource=resource, metric_readers=[PeriodicExportingMetricReader(OTLPMetricExporter())])
    )
    FastAPIInstrumentor.instrument_app(app, excluded_urls="health")
    HTTPXClientInstrumentor().instrument()
    PsycopgInstrumentor().instrument(enable_commenter=False)
    if os.environ.get("OTEL_LOGS_EXPORTER", "otlp").lower() != "none":
        _bridge_logs(resource)
    log.info("telemetry on: exporting over OTLP")
    return True


def _bridge_logs(resource) -> None:
    """Python logging to OTLP (local runs with Aspire; production reads stdout instead)."""
    from opentelemetry._logs import set_logger_provider
    from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
    from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
    from opentelemetry.sdk._logs.export import BatchLogRecordProcessor

    provider = LoggerProvider(resource=resource)
    provider.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter()))
    set_logger_provider(provider)
    logging.getLogger().addHandler(LoggingHandler(logger_provider=provider))


def extract_context(headers: list[tuple[str, bytes | str]] | None) -> Context:
    """The trace a Kafka message carries (a new one when it carries none)."""
    carrier = {k: (v.decode() if isinstance(v, bytes) else v) for k, v in headers or [] if v is not None}
    return _propagator.extract(carrier)


def inject_headers(context: Context | None = None) -> list[tuple[str, bytes]]:
    """Kafka headers carrying the current (or given) trace."""
    carrier: dict[str, str] = {}
    _propagator.inject(carrier, context=context)
    return [(k, v.encode()) for k, v in carrier.items()]


@contextmanager
def consumer_span(name: str, headers: list[tuple[str, bytes | str]] | None) -> Iterator[trace.Span]:
    """A span for handling one Kafka message, inside the trace the message carries."""
    with tracer.start_as_current_span(name, context=extract_context(headers), kind=trace.SpanKind.CONSUMER) as span:
        yield span


def record_receipt(outcome: str) -> None:
    _receipts_read.add(1, {"outcome": outcome})


def record_sentence(outcome: str) -> None:
    _sentences_parsed.add(1, {"outcome": outcome})


@contextmanager
def model_call(kind: str) -> Iterator[None]:
    """Counts one request to the model for a feature, by how it ended; the exception, if any, carries on."""
    try:
        yield
    except RateLimited:
        _model_calls.add(1, {"kind": kind, "result": "rate_limited"})
        raise
    except Exception:
        _model_calls.add(1, {"kind": kind, "result": "error"})
        raise
    _model_calls.add(1, {"kind": kind, "result": "ok"})
