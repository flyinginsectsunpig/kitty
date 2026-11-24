// Package kafkaconsume runs pulse's Kafka consumers: one record at a time, in order, committed after it's handled.
package kafkaconsume

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// Skip marks a record that will never be handled (unreadable, or data the database rejects). It's logged and
// committed, so it can't block the records after it.
type Skip struct{ Err error }

func (s Skip) Error() string { return "skip: " + s.Err.Error() }
func (s Skip) Unwrap() error { return s.Err }

// RetryEvery is how long Run waits before handling a record again after a non-Skip error.
var RetryEvery = 5 * time.Second

// NewClient reads topic from the start as group, committing offsets by hand.
func NewClient(brokers, topic, group string) (*kgo.Client, error) {
	return kgo.NewClient(
		kgo.SeedBrokers(brokers),
		kgo.ConsumerGroup(group),
		kgo.ConsumeTopics(topic),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtStart()),
		kgo.DisableAutoCommit(),
	)
}

// Run hands each record's value to handle until ctx ends, then commits it. nil: done. Skip: logged and committed.
// Any other error (a database or a provider being down): retried every RetryEvery, so records stay in order and a
// crash re-reads at most the uncommitted ones (handlers must be idempotent).
func Run(ctx context.Context, client *kgo.Client, name string, handle func(ctx context.Context, value []byte) error) error {
	for {
		fetches := client.PollFetches(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		fetches.EachError(func(topic string, partition int32, err error) {
			slog.WarnContext(ctx, name+" topic read failed", "topic", topic, "partition", partition, "err", err)
		})
		var done []*kgo.Record
		fetches.EachRecord(func(r *kgo.Record) {
			if ctx.Err() != nil {
				return
			}
			if handleUntilDone(ctx, name, r, handle) {
				done = append(done, r)
			}
		})
		if len(done) > 0 {
			if err := client.CommitRecords(ctx, done...); err != nil && !errors.Is(err, context.Canceled) {
				slog.WarnContext(ctx, name+" offset commit failed", "err", err)
			}
		}
	}
}

// handleUntilDone is false only when ctx ends before the record is dealt with.
func handleUntilDone(ctx context.Context, name string, r *kgo.Record, handle func(context.Context, []byte) error) bool {
	for {
		err := handle(ctx, r.Value)
		var skip Skip
		switch {
		case err == nil:
			return true
		case errors.As(err, &skip):
			slog.WarnContext(ctx, "skipping a "+name+" record", "key", string(r.Key), "offset", r.Offset, "err", skip.Err)
			return true
		}
		slog.WarnContext(ctx, name+" record not handled; retrying", "key", string(r.Key), "err", err)
		select {
		case <-ctx.Done():
			return false
		case <-time.After(RetryEvery):
		}
	}
}
