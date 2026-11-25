package notify

import (
	"context"
	"slices"
	"testing"
	"time"
)

func TestWeekly_QueuesOnMondayAfterSixUTCOnce(t *testing.T) {
	l := &fakeLedger{}
	now := time.Date(2026, 11, 30, 5, 59, 0, 0, time.UTC) // Monday, before 06:00 UTC
	w := &Weekly{Ledger: l, Now: func() time.Time { return now }}

	_ = w.Tick(context.Background())
	if len(l.weeks) != 0 {
		t.Fatalf("queued before 06:00: %v", l.weeks)
	}
	now = now.Add(2 * time.Minute) // 06:01
	_ = w.Tick(context.Background())
	now = now.Add(time.Hour)
	_ = w.Tick(context.Background()) // later the same Monday: already done
	now = time.Date(2026, 12, 2, 9, 0, 0, 0, time.UTC)
	_ = w.Tick(context.Background()) // Wednesday: nothing
	now = time.Date(2026, 12, 7, 6, 0, 0, 0, time.UTC)
	_ = w.Tick(context.Background()) // next Monday

	if !slices.Equal(l.weeks, []string{"2026-W49", "2026-W50"}) {
		t.Fatalf("weeks = %v", l.weeks)
	}
}

// pulse was down all Monday: the week's summaries still go out once it's back, later that week.
func TestWeekly_CatchesUpLaterInTheWeek(t *testing.T) {
	l := &fakeLedger{}
	now := time.Date(2026, 12, 2, 9, 0, 0, 0, time.UTC) // Wednesday of 2026-W49, nothing asked yet
	w := &Weekly{Ledger: l, Now: func() time.Time { return now }}

	_ = w.Tick(context.Background())
	_ = w.Tick(context.Background())

	if !slices.Equal(l.weeks, []string{"2026-W49"}) {
		t.Fatalf("weeks = %v", l.weeks)
	}
}
