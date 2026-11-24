package recurring

import (
	"context"
	"testing"
	"time"

	recurringv1 "github.com/flyinginsectsunpig/kitty/services/pulse/gen/kitty/recurring/v1"
	"github.com/twmb/franz-go/pkg/kgo"
	"google.golang.org/protobuf/proto"
)

func TestConsume_UpsertsFromTopic(t *testing.T) {
	s := openStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	topic := "ledger.recurring.test"
	producer, err := kgo.NewClient(kgo.SeedBrokers(testKafka), kgo.AllowAutoTopicCreation())
	if err != nil {
		t.Fatal(err)
	}
	defer producer.Close()

	id := "b0000000-0000-0000-0000-000000000001"
	payload, err := proto.Marshal(&recurringv1.RecurringScheduleChanged{
		EventId: "e1", ScheduleId: id, GroupId: "c0000000-0000-0000-0000-000000000001", Frequency: recurringv1.RecurringScheduleChanged_FREQUENCY_WEEKLY,
		StartsOn: "2026-11-27", NotBefore: "2026-11-27", EndsOn: "2027-02-26", Version: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Framed the way the ledger's Confluent serializer writes it: magic, schema id 9, index [0], payload.
	value := append([]byte{0, 0, 0, 0, 9, 0}, payload...)
	malformed := &kgo.Record{Topic: topic, Key: []byte("bad"), Value: []byte{9, 9}}
	good := &kgo.Record{Topic: topic, Key: []byte(id), Value: value}
	if err := producer.ProduceSync(ctx, malformed, good).FirstErr(); err != nil {
		t.Fatal(err)
	}

	consumer, err := NewConsumerClient(testKafka, topic, "pulse-test-"+time.Now().Format("150405.000"))
	if err != nil {
		t.Fatal(err)
	}
	defer consumer.Close()
	go func() { _ = Consume(ctx, consumer, s) }()

	for {
		if got, ok := liveByID(t, s, id); ok {
			if got.Rule.Frequency != Weekly || !got.Rule.StartsOn.Equal(date(2026, 11, 27)) ||
				got.EndsOn == nil || !got.EndsOn.Equal(date(2027, 2, 26)) {
				t.Fatalf("got %+v", got)
			}
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("the schedule never arrived (a malformed record must be skipped, not block the topic)")
		case <-time.After(200 * time.Millisecond):
		}
	}
}

func TestConsume_ARecordTheDatabaseRejectsIsSkipped(t *testing.T) {
	s := openStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	topic := "ledger.recurring.poison"
	producer, err := kgo.NewClient(kgo.SeedBrokers(testKafka), kgo.AllowAutoTopicCreation())
	if err != nil {
		t.Fatal(err)
	}
	defer producer.Close()

	frame := func(groupID, id string) *kgo.Record {
		b, _ := proto.Marshal(&recurringv1.RecurringScheduleChanged{
			ScheduleId: id, GroupId: groupID, Frequency: recurringv1.RecurringScheduleChanged_FREQUENCY_MONTHLY,
			StartsOn: "2026-12-01", NotBefore: "2026-12-01", Version: 1,
		})
		return &kgo.Record{Topic: topic, Key: []byte(id), Value: append([]byte{0, 0, 0, 0, 9, 0}, b...)}
	}
	good := "b0000000-0000-0000-0000-000000000002"
	if err := producer.ProduceSync(ctx, frame("not-a-uuid", "b0000000-0000-0000-0000-000000000003"),
		frame("c0000000-0000-0000-0000-000000000001", good)).FirstErr(); err != nil {
		t.Fatal(err)
	}

	consumer, err := NewConsumerClient(testKafka, topic, "pulse-poison-"+time.Now().Format("150405.000"))
	if err != nil {
		t.Fatal(err)
	}
	defer consumer.Close()
	go func() { _ = Consume(ctx, consumer, s) }()

	for {
		if _, ok := liveByID(t, s, good); ok {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("a record the database rejects blocked the ones after it")
		case <-time.After(200 * time.Millisecond):
		}
	}
}
