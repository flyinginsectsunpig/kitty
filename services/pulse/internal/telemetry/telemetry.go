// Package telemetry sets up OpenTelemetry for pulse (phase 5b) and holds its counters.
//
// It is configured only by the standard OTEL_* variables: without OTEL_EXPORTER_OTLP_ENDPOINT nothing is exported.
// In production pulse sends to the cluster's collector, which scrubs before anything leaves the server. Exports are
// batched in the background and never block a delivery.
package telemetry

import (
	"context"
	"errors"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

const scope = "kitty/pulse"

// Setup installs the OTLP trace and metric exporters when OTEL_EXPORTER_OTLP_ENDPOINT is set; otherwise it does
// nothing. The returned shutdown flushes what's buffered and is always safe to call.
func Setup(ctx context.Context, service string) (func(context.Context) error, error) {
	if os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") == "" {
		return func(context.Context) error { return nil }, nil
	}
	// OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES win over the default service name.
	res, err := resource.Merge(resource.NewSchemaless(semconv.ServiceName(service)), resource.Environment())
	if err != nil {
		return nil, err
	}
	traces, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, err
	}
	metrics, err := otlpmetrichttp.New(ctx)
	if err != nil {
		return nil, err
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(traces), sdktrace.WithResource(res))
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metrics)), sdkmetric.WithResource(res))
	otel.SetTracerProvider(tp)
	otel.SetMeterProvider(mp)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	return func(ctx context.Context) error { return errors.Join(tp.Shutdown(ctx), mp.Shutdown(ctx)) }, nil
}

// Notification channels and results for RecordNotification.
const (
	Email  = "email"
	Push   = "push"
	Sent   = "sent"
	Failed = "failed"
)

// RecordNotification counts one delivery attempt that ended: kitty.notifications.sent{channel,result}.
func RecordNotification(ctx context.Context, channel, result string) {
	counter("kitty.notifications.sent", "Notifications delivered, by channel and result").
		Add(ctx, 1, metric.WithAttributes(attribute.String("channel", channel), attribute.String("result", result)))
}

// RecordRecurringAdded counts one recurring-expense period added to the ledger: kitty.recurring.added.
func RecordRecurringAdded(ctx context.Context) {
	counter("kitty.recurring.added", "Recurring-expense periods added").Add(ctx, 1)
}

// counter looks the instrument up on the current global meter provider, so a provider set after start-up (or by a
// test) is the one that counts. The SDK caches instruments by name, so this is cheap.
func counter(name, description string) metric.Int64Counter {
	c, _ := otel.Meter(scope).Int64Counter(name, metric.WithDescription(description))
	return c
}
