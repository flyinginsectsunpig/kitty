package recurring

import (
	"context"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type fakeSchedules struct {
	live      []Schedule
	lastAdded map[string]time.Time
}

func (f *fakeSchedules) Live(context.Context) ([]Schedule, error) {
	out := make([]Schedule, len(f.live))
	for i, s := range f.live {
		if d, ok := f.lastAdded[s.ID]; ok {
			s.LastAdded = &d
		}
		out[i] = s
	}
	return out, nil
}

func (f *fakeSchedules) SetLastAdded(_ context.Context, id string, period time.Time) error {
	f.lastAdded[id] = period
	return nil
}

type call struct {
	id     string
	period string
}

type fakeLedger struct {
	calls []call
	fail  map[string]error // by period
}

func (f *fakeLedger) AddOccurrence(_ context.Context, id string, period time.Time) error {
	p := period.Format(time.DateOnly)
	f.calls = append(f.calls, call{id, p})
	return f.fail[p]
}

func scheduler(today time.Time, schedules ...Schedule) (*Scheduler, *fakeSchedules, *fakeLedger) {
	store := &fakeSchedules{live: schedules, lastAdded: map[string]time.Time{}}
	ledger := &fakeLedger{fail: map[string]error{}}
	return &Scheduler{Store: store, Ledger: ledger, Now: func() time.Time { return today.Add(3 * time.Hour) }}, store, ledger
}

func weeklyFrom(start time.Time) Schedule {
	return Schedule{ID: "s1", Rule: Rule{Frequency: Weekly, StartsOn: start}, NotBefore: start, Version: 1}
}

func periods(calls []call) []string {
	out := make([]string, len(calls))
	for i, c := range calls {
		out[i] = c.period
	}
	return out
}

func TestTick_AddsTodaysPeriod(t *testing.T) {
	s, store, ledger := scheduler(date(2026, 11, 24), weeklyFrom(date(2026, 11, 24)))

	if err := s.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := periods(ledger.calls); len(got) != 1 || got[0] != "2026-11-24" {
		t.Fatalf("calls = %v", got)
	}
	if !store.lastAdded["s1"].Equal(date(2026, 11, 24)) {
		t.Fatalf("last added = %v", store.lastAdded["s1"])
	}
	// The next tick that day adds nothing more.
	ledger.calls = nil
	_ = s.Tick(context.Background())
	if len(ledger.calls) != 0 {
		t.Fatalf("calls on the second tick = %v", ledger.calls)
	}
}

func TestTick_CatchUpAddsOnlyTheLatest12(t *testing.T) {
	start := date(2026, 1, 6) // a Tuesday; 20 weeks later is 2026-05-26
	sched := weeklyFrom(start)
	s, store, ledger := scheduler(date(2026, 5, 26), sched)
	store.lastAdded["s1"] = start // only the first week was ever added

	if err := s.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := periods(ledger.calls)
	if len(got) != 12 || got[0] != "2026-03-10" || got[11] != "2026-05-26" {
		t.Fatalf("calls = %v, want the 12 most recent weeks, oldest first", got)
	}
}

func TestTick_PeriodsBeforeNotBeforeAreNeverAdded(t *testing.T) {
	sched := weeklyFrom(date(2026, 11, 3))
	sched.NotBefore = date(2026, 11, 20) // resumed on the 20th after a pause
	s, _, ledger := scheduler(date(2026, 11, 24), sched)

	_ = s.Tick(context.Background())

	if got := periods(ledger.calls); len(got) != 1 || got[0] != "2026-11-24" {
		t.Fatalf("calls = %v", got)
	}
}

func TestTick_EndsOnStopsIt(t *testing.T) {
	sched := weeklyFrom(date(2026, 11, 3))
	end := date(2026, 11, 10)
	sched.EndsOn = &end
	s, _, ledger := scheduler(date(2026, 11, 24), sched)

	_ = s.Tick(context.Background())

	if got := periods(ledger.calls); len(got) != 2 || got[1] != "2026-11-10" {
		t.Fatalf("calls = %v", got)
	}
}

func TestTick_FailedPreconditionIsSkipped(t *testing.T) {
	s, store, ledger := scheduler(date(2026, 11, 24), weeklyFrom(date(2026, 11, 17)))
	ledger.fail["2026-11-17"] = status.Error(codes.FailedPrecondition, "paused")

	_ = s.Tick(context.Background())

	if got := periods(ledger.calls); len(got) != 2 {
		t.Fatalf("calls = %v: a dropped period must not stop later ones", got)
	}
	if !store.lastAdded["s1"].Equal(date(2026, 11, 24)) {
		t.Fatalf("last added = %v", store.lastAdded["s1"])
	}
}

func TestTick_UnavailableIsRetriedNextTick(t *testing.T) {
	s, store, ledger := scheduler(date(2026, 11, 24), weeklyFrom(date(2026, 11, 17)))
	ledger.fail["2026-11-24"] = status.Error(codes.Unavailable, "not due yet")

	_ = s.Tick(context.Background())

	if !store.lastAdded["s1"].Equal(date(2026, 11, 17)) {
		t.Fatalf("last added = %v, want the 17th (the 24th must be retried)", store.lastAdded["s1"])
	}
	delete(ledger.fail, "2026-11-24")
	ledger.calls = nil
	_ = s.Tick(context.Background())
	if got := periods(ledger.calls); len(got) != 1 || got[0] != "2026-11-24" {
		t.Fatalf("retry calls = %v", got)
	}
}
