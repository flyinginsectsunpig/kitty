package notify

import (
	"context"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// sentCounts reads kitty.notifications.sent as {"channel/result": value}.
func sentCounts(t *testing.T, reader *sdkmetric.ManualReader) map[string]int64 {
	t.Helper()
	var rm metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	out := map[string]int64{}
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			if m.Name != "kitty.notifications.sent" {
				continue
			}
			for _, p := range m.Data.(metricdata.Sum[int64]).DataPoints {
				ch, _ := p.Attributes.Value(attribute.Key("channel"))
				res, _ := p.Attributes.Value(attribute.Key("result"))
				if p.Attributes.Len() != 2 {
					t.Fatalf("unexpected labels: %v", p.Attributes.ToSlice())
				}
				out[ch.AsString()+"/"+res.AsString()] = p.Value
			}
		}
	}
	return out
}

func TestDeliveryIsCounted(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	otel.SetMeterProvider(sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader)))

	r := newRig()
	s := r.settings.byUser[userA]
	s.Tokens = []string{"t1", "dead"}
	r.settings.byUser[userA] = s
	r.push.result["dead"] = PushDeadToken
	if err := r.d.Handle(context.Background(), request("n1", expense)); err != nil {
		t.Fatal(err)
	}

	got := sentCounts(t, reader)
	if got["push/sent"] != 1 || got["push/failed"] != 1 || got["email/sent"] != 1 {
		t.Fatalf("counts = %v", got)
	}
}
