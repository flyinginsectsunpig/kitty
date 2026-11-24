package recurring

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

// Runs contracts/fixtures/recurrence.json — the same file the ledger's C# tests run.
type fixture struct {
	Between []struct {
		Name, Frequency, StartsOn, From, To string
		Expected                            []string
	}
	IsOccurrence []struct {
		Name, Frequency, StartsOn, Date string
		Expected                        bool
	}
	NextCycleStart []struct {
		Name, Frequency, Period, Expected string
	}
}

func load(t *testing.T) fixture {
	t.Helper()
	b, err := os.ReadFile("../../../../contracts/fixtures/recurrence.json")
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func day(t *testing.T, s string) time.Time {
	t.Helper()
	d, err := time.Parse("2006-01-02", s)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func freq(t *testing.T, s string) Frequency {
	t.Helper()
	switch s {
	case "weekly":
		return Weekly
	case "monthly":
		return Monthly
	}
	t.Fatalf("unknown frequency %q", s)
	return 0
}

func TestBetween_Fixture(t *testing.T) {
	for _, c := range load(t).Between {
		t.Run(c.Name, func(t *testing.T) {
			got := Between(Rule{Frequency: freq(t, c.Frequency), StartsOn: day(t, c.StartsOn)}, day(t, c.From), day(t, c.To))
			if len(got) != len(c.Expected) {
				t.Fatalf("got %v, want %v", got, c.Expected)
			}
			for i := range got {
				if got[i].Format("2006-01-02") != c.Expected[i] {
					t.Fatalf("got %v, want %v", got, c.Expected)
				}
			}
		})
	}
}

func TestIsOccurrence_Fixture(t *testing.T) {
	for _, c := range load(t).IsOccurrence {
		t.Run(c.Name, func(t *testing.T) {
			if got := IsOccurrence(Rule{Frequency: freq(t, c.Frequency), StartsOn: day(t, c.StartsOn)}, day(t, c.Date)); got != c.Expected {
				t.Fatalf("got %v, want %v", got, c.Expected)
			}
		})
	}
}

func TestNextCycleStart_Fixture(t *testing.T) {
	for _, c := range load(t).NextCycleStart {
		t.Run(c.Name, func(t *testing.T) {
			if got := NextCycleStart(freq(t, c.Frequency), day(t, c.Period)); got.Format("2006-01-02") != c.Expected {
				t.Fatalf("got %s, want %s", got.Format("2006-01-02"), c.Expected)
			}
		})
	}
}
