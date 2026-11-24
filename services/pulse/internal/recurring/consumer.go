package recurring

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	recurringv1 "github.com/flyinginsectsunpig/kitty/services/pulse/gen/kitty/recurring/v1"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/twmb/franz-go/pkg/kgo"
	"google.golang.org/protobuf/proto"
)

// Topic is the ledger's compacted topic of schedule states, keyed by schedule id.
const Topic = "ledger.recurring"

// NewConsumerClient reads topic from the start as group, committing offsets by hand (after each upsert).
func NewConsumerClient(brokers, topic, group string) (*kgo.Client, error) {
	return kgo.NewClient(
		kgo.SeedBrokers(brokers),
		kgo.ConsumerGroup(group),
		kgo.ConsumeTopics(topic),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		kgo.DisableAutoCommit(),
	)
}

// Consume keeps the store in step with the topic until ctx ends. Each record is upserted (retried until the database
// answers), then committed, so a crash re-reads at most the uncommitted ones; upserts are idempotent. A record that
// can't be read is logged and skipped.
func Consume(ctx context.Context, client *kgo.Client, store *Store) error {
	for {
		fetches := client.PollFetches(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		fetches.EachError(func(topic string, partition int32, err error) {
			slog.WarnContext(ctx, "schedule topic read failed", "topic", topic, "partition", partition, "err", err)
		})
		var done []*kgo.Record
		fetches.EachRecord(func(r *kgo.Record) {
			if ctx.Err() != nil {
				return
			}
			if s, err := decode(r.Value); err != nil {
				slog.WarnContext(ctx, "skipping unreadable schedule record", "key", string(r.Key), "offset", r.Offset, "err", err)
			} else if !upsertUntilDone(ctx, store, s) {
				return
			}
			done = append(done, r)
		})
		if len(done) > 0 {
			if err := client.CommitRecords(ctx, done...); err != nil && !errors.Is(err, context.Canceled) {
				slog.WarnContext(ctx, "schedule offset commit failed", "err", err)
			}
		}
	}
}

// upsertUntilDone keeps trying while the database is unreachable; false only when ctx ends first. A record the
// database rejects outright (bad data: SQLSTATE class 22 or 23) is logged and skipped, so it can't block the topic.
func upsertUntilDone(ctx context.Context, store *Store, s Schedule) bool {
	for {
		err := store.Upsert(ctx, s)
		if err == nil {
			return true
		}
		var pg *pgconn.PgError
		if errors.As(err, &pg) && (strings.HasPrefix(pg.Code, "22") || strings.HasPrefix(pg.Code, "23")) {
			slog.WarnContext(ctx, "skipping a schedule the database rejects", "schedule", s.ID, "err", err)
			return true
		}
		slog.WarnContext(ctx, "schedule upsert failed; retrying", "schedule", s.ID, "err", err)
		select {
		case <-ctx.Done():
			return false
		case <-time.After(5 * time.Second):
		}
	}
}

func decode(value []byte) (Schedule, error) {
	payload, err := StripConfluentHeader(value)
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
