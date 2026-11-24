package recurring

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	recurringv1 "github.com/flyinginsectsunpig/kitty/services/pulse/gen/kitty/recurring/v1"
	"github.com/flyinginsectsunpig/kitty/services/pulse/internal/kafkaconsume"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/twmb/franz-go/pkg/kgo"
	"google.golang.org/protobuf/proto"
)

// Topic is the ledger's compacted topic of schedule states, keyed by schedule id.
const Topic = "ledger.recurring"

// NewConsumerClient reads topic from the start as group, committing offsets by hand (after each upsert).
func NewConsumerClient(brokers, topic, group string) (*kgo.Client, error) {
	return kafkaconsume.NewClient(brokers, topic, group)
}

// Consume keeps the store in step with the topic until ctx ends. Each record is upserted (retried until the database
// answers), then committed; upserts are idempotent. An unreadable record, or one the database rejects outright, is
// skipped so it can't block the topic.
func Consume(ctx context.Context, client *kgo.Client, store *Store) error {
	return kafkaconsume.Run(ctx, client, "schedule", func(ctx context.Context, value []byte) error {
		s, err := decode(value)
		if err != nil {
			return kafkaconsume.Skip{Err: err}
		}
		return RejectedAsSkip(store.Upsert(ctx, s))
	})
}

// RejectedAsSkip turns an error the database will give every time (bad data: SQLSTATE class 22 or 23) into a Skip.
func RejectedAsSkip(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && (strings.HasPrefix(pg.Code, "22") || strings.HasPrefix(pg.Code, "23")) {
		return kafkaconsume.Skip{Err: err}
	}
	return err
}

func decode(value []byte) (Schedule, error) {
	payload, err := kafkaconsume.StripConfluentHeader(value)
	if err != nil {
		return Schedule{}, err
	}
	var m recurringv1.RecurringScheduleChanged
	if err := proto.Unmarshal(payload, &m); err != nil {
		return Schedule{}, fmt.Errorf("decode: %w", err)
	}
	return fromMessage(&m)
}

func fromMessage(m *recurringv1.RecurringScheduleChanged) (Schedule, error) {
	var freq Frequency
	switch m.GetFrequency() {
	case recurringv1.RecurringScheduleChanged_FREQUENCY_WEEKLY:
		freq = Weekly
	case recurringv1.RecurringScheduleChanged_FREQUENCY_MONTHLY:
		freq = Monthly
	default:
		return Schedule{}, errors.New("decode: no frequency")
	}
	starts, err := time.Parse(time.DateOnly, m.GetStartsOn())
	if err != nil {
		return Schedule{}, fmt.Errorf("decode: starts_on: %w", err)
	}
	notBefore, err := time.Parse(time.DateOnly, m.GetNotBefore())
	if err != nil {
		return Schedule{}, fmt.Errorf("decode: not_before: %w", err)
	}
	s := Schedule{
		ID: m.GetScheduleId(), GroupID: m.GetGroupId(), Rule: Rule{Frequency: freq, StartsOn: starts},
		NotBefore: notBefore, Paused: m.GetPaused(), Deleted: m.GetDeleted(), Version: m.GetVersion(),
	}
	if m.GetEndsOn() != "" {
		end, err := time.Parse(time.DateOnly, m.GetEndsOn())
		if err != nil {
			return Schedule{}, fmt.Errorf("decode: ends_on: %w", err)
		}
		s.EndsOn = &end
	}
	return s, nil
}
