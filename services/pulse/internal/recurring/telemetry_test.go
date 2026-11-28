package recurring

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

func TestRecurringAddIsCounted(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	otel.SetMeterProvider(sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader)))

	s, _, _ := scheduler(date(2026, 11, 24), weeklyFrom(date(2026, 11, 24)))
	if err := s.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}

	var rm metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	var added int64
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name == "kitty.recurring.added" {
				for _, p := range m.Data.(metricdata.Sum[int64]).DataPoints {
					added += p.Value
				}
			}
		}
	}
	if added != 1 {
		t.Fatalf("kitty.recurring.added = %d, want 1", added)
	}
}
