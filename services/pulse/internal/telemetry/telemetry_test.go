package telemetry

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

func TestSetupWithoutEndpointIsNoop(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	shutdown, err := Setup(context.Background(), "pulse")
	if err != nil {
		t.Fatal(err)
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, isSDK := otel.GetTracerProvider().(*sdktrace.TracerProvider); isSDK {
		t.Fatal("an SDK tracer provider was installed without an endpoint")
	}
}
