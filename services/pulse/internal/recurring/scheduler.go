package recurring

import (
	"context"
	"log/slog"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// CatchUpLimit is the most periods added for one schedule in a run of missed ones (only the most recent).
const CatchUpLimit = 12

// Adder asks the ledger to add one period of a schedule. Success includes "already added".
type Adder interface {
	AddOccurrence(ctx context.Context, scheduleID string, period time.Time) error
}

// Schedules is where pulse's copy of the schedules lives.
type Schedules interface {
	Live(ctx context.Context) ([]Schedule, error)
	SetLastAdded(ctx context.Context, id string, period time.Time) error
}

// Scheduler adds every due period of every live schedule.
type Scheduler struct {
	Store  Schedules
	Ledger Adder
	Now    func() time.Time
}

// Tick adds what's due now. For each schedule: the periods after the last one added (and not before NotBefore), up to
// today and the end date, the latest CatchUpLimit only, oldest first. A period the ledger refuses for good
// (FAILED_PRECONDITION) counts as dealt with; anything else (UNAVAILABLE, "not due yet", a network error) stops that
// schedule until the next tick.
func (s *Scheduler) Tick(ctx context.Context) error {
	live, err := s.Store.Live(ctx)
	if err != nil {
		return err
	}
	now := s.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	for _, sch := range live {
		for _, period := range Due(sch, today) {
			err := s.Ledger.AddOccurrence(ctx, sch.ID, period)
			if err != nil && status.Code(err) != codes.FailedPrecondition {
				slog.WarnContext(ctx, "recurring period not added; retrying next tick",
					"schedule", sch.ID, "period", period.Format(time.DateOnly), "err", err)
				break
			}
			if err != nil {
				slog.InfoContext(ctx, "recurring period dropped by the ledger",
					"schedule", sch.ID, "period", period.Format(time.DateOnly), "reason", status.Convert(err).Message())
			}
			if err := s.Store.SetLastAdded(ctx, sch.ID, period); err != nil {
				return err
			}
		}
	}
	return nil
}

// Due is the periods a schedule owes as of today, oldest first, at most CatchUpLimit.
func Due(sch Schedule, today time.Time) []time.Time {
	from := sch.NotBefore
	if sch.LastAdded != nil && !sch.LastAdded.Before(from) {
		from = sch.LastAdded.AddDate(0, 0, 1)
	}
	to := today
	if sch.EndsOn != nil && sch.EndsOn.Before(to) {
		to = *sch.EndsOn
	}
	due := Between(sch.Rule, from, to)
	if len(due) > CatchUpLimit {
		due = due[len(due)-CatchUpLimit:]
	}
	return due
}

// Run ticks every interval until ctx ends.
func (s *Scheduler) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if err := s.Tick(ctx); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "recurring tick failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
