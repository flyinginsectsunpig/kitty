package notify

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// Weekly asks the ledger for each ISO week's summaries once, from Monday 06:00 UTC, or later that week if pulse was
// down then. The ledger queues each person's summary once per week, so asking again after a restart is harmless.
type Weekly struct {
	Ledger Ledger
	Now    func() time.Time
	done   string // the ISO week already asked for
}

// Tick asks for this week's summaries unless it's before Monday 06:00 or that already happened.
func (w *Weekly) Tick(ctx context.Context) error {
	now := w.Now().UTC()
	if now.Weekday() == time.Monday && now.Hour() < 6 {
		return nil // this week's summaries go out from 06:00
	}
	year, week := now.ISOWeek()
	name := fmt.Sprintf("%d-W%02d", year, week)
	if name == w.done {
		return nil
	}
	if err := w.Ledger.QueueWeeklySummaries(ctx, name); err != nil {
		return fmt.Errorf("weekly summaries %s: %w", name, err)
	}
	w.done = name
	return nil
}

// RunWeekly ticks every minute until ctx ends; a failed ask is tried again on the next tick.
func RunWeekly(ctx context.Context, l Ledger, now func() time.Time) {
	w := &Weekly{Ledger: l, Now: now}
	for {
		if err := w.Tick(ctx); err != nil {
			slog.WarnContext(ctx, "weekly summaries not queued; retrying", "err", err)
		}
		if Sleep(ctx, time.Minute) != nil {
			return
		}
	}
}
