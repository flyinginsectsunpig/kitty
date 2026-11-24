package notify

import (
	"context"
	"errors"
	"net/textproto"
	"slices"
	"testing"
	"time"

	notifyv1 "github.com/flyinginsectsunpig/kitty/services/pulse/gen/kitty/notify/v1"
	"github.com/flyinginsectsunpig/kitty/services/pulse/internal/kafkaconsume"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type fakeDeliveries struct{ done map[string]bool }

func (f *fakeDeliveries) Delivered(_ context.Context, id string, ch Channel) (bool, error) {
	return f.done[id+"/"+string(ch)], nil
}
func (f *fakeDeliveries) MarkDelivered(_ context.Context, id string, ch Channel) error {
	f.done[id+"/"+string(ch)] = true
	return nil
}

type fakeSettings struct{ byUser map[string]Settings }

func (f *fakeSettings) Get(_ context.Context, id string) (Settings, bool, error) {
	s, ok := f.byUser[id]
	return s, ok, nil
}

type fakePusher struct {
	sent   []string
	result map[string]PushResult
}

func (f *fakePusher) Push(_ context.Context, token string, _ Message) (PushResult, error) {
	r, ok := f.result[token]
	if !ok {
		r = PushSent
	}
	if r == PushSent {
		f.sent = append(f.sent, token)
		return r, nil
	}
	return r, errors.New("push failed")
}

type fakeMailer struct {
	sent []string
	err  error
}

func (f *fakeMailer) Send(_ context.Context, to string, _ Message) error {
	if f.err != nil {
		return f.err
	}
	f.sent = append(f.sent, to)
	return nil
}

type fakeLedger struct{ forgotten, weeks []string }

func (f *fakeLedger) ForgetDevice(_ context.Context, token string) error {
	f.forgotten = append(f.forgotten, token)
	return nil
}
func (f *fakeLedger) QueueWeeklySummaries(_ context.Context, week string) error {
	f.weeks = append(f.weeks, week)
	return nil
}

var occurred = time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)

type rig struct {
	d        *Dispatcher
	settings *fakeSettings
	push     *fakePusher
	mail     *fakeMailer
	ledger   *fakeLedger
	now      time.Time
}

func newRig() *rig {
	r := &rig{
		settings: &fakeSettings{byUser: map[string]Settings{userA: {
			UserID: userA, Email: "a@example.com", ExpensePush: true, ExpenseEmail: true, Tokens: []string{"t1"}, Version: 1,
		}}},
		push: &fakePusher{result: map[string]PushResult{}}, mail: &fakeMailer{}, ledger: &fakeLedger{},
		now: occurred.Add(time.Minute),
	}
	r.d = &Dispatcher{
		Deliveries: &fakeDeliveries{done: map[string]bool{}}, Settings: r.settings, Push: r.push, Mail: r.mail, Ledger: r.ledger,
		Now: func() time.Time { return r.now }, Wait: func(context.Context, time.Duration) error { return nil },
	}
	return r
}

func request(id string, kind notifyv1.NotificationRequested_Kind) []byte {
	b, _ := proto.Marshal(&notifyv1.NotificationRequested{
		NotificationId: id, UserId: userA, Kind: kind, Title: "Flat 4B", Body: "Sam added Groceries", Link: "kitty://groups/g1",
		OccurredAt: timestamppb.New(occurred),
	})
	return append([]byte{0, 0, 0, 0, 7, 0}, b...)
}

const expense = notifyv1.NotificationRequested_KIND_EXPENSE_ADDED

func TestDispatch_SendsPushAndEmailPerSettings(t *testing.T) {
	r := newRig()
	if err := r.d.Handle(context.Background(), request("n1", expense)); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(r.push.sent, []string{"t1"}) || !slices.Equal(r.mail.sent, []string{"a@example.com"}) {
		t.Fatalf("push=%v mail=%v", r.push.sent, r.mail.sent)
	}
	// Payments: push only (email off), weekly: nothing (off).
	r.push.sent, r.mail.sent = nil, nil
	s := r.settings.byUser[userA]
	s.PaymentPush = true
	r.settings.byUser[userA] = s
	_ = r.d.Handle(context.Background(), request("n2", notifyv1.NotificationRequested_KIND_PAYMENT))
	_ = r.d.Handle(context.Background(), request("n3", notifyv1.NotificationRequested_KIND_WEEKLY_SUMMARY))
	if len(r.push.sent) != 1 || len(r.mail.sent) != 0 {
		t.Fatalf("push=%v mail=%v", r.push.sent, r.mail.sent)
	}
}

func TestDispatch_AppliesCurrentSettings(t *testing.T) {
	r := newRig()
	s := r.settings.byUser[userA]
	s.ExpensePush = false // turned off after the request was queued
	r.settings.byUser[userA] = s

	_ = r.d.Handle(context.Background(), request("n1", expense))

	if len(r.push.sent) != 0 || len(r.mail.sent) != 1 {
		t.Fatalf("push=%v mail=%v", r.push.sent, r.mail.sent)
	}
}

func TestDispatch_RedeliveredRequestIsSentOnce(t *testing.T) {
	r := newRig()
	_ = r.d.Handle(context.Background(), request("n1", expense))
	_ = r.d.Handle(context.Background(), request("n1", expense)) // Kafka redelivered it

	if len(r.push.sent) != 1 || len(r.mail.sent) != 1 {
		t.Fatalf("push=%v mail=%v", r.push.sent, r.mail.sent)
	}
}

func TestDispatch_DeadTokenIsForgottenOthersStillSent(t *testing.T) {
	r := newRig()
	s := r.settings.byUser[userA]
	s.Tokens = []string{"dead", "alive"}
	r.settings.byUser[userA] = s
	r.push.result["dead"] = PushDeadToken

	if err := r.d.Handle(context.Background(), request("n1", expense)); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(r.ledger.forgotten, []string{"dead"}) || !slices.Equal(r.push.sent, []string{"alive"}) {
		t.Fatalf("forgotten=%v sent=%v", r.ledger.forgotten, r.push.sent)
	}
}

func TestDispatch_TransientErrorRetriesThenGivesUpAfterAnHour(t *testing.T) {
	r := newRig()
	r.push.result["t1"] = PushRetry
	r.mail.err = &textproto.Error{Code: 451, Msg: "try later"}

	err := r.d.Handle(context.Background(), request("n1", expense))
	var skip kafkaconsume.Skip
	if err == nil || errors.As(err, &skip) {
		t.Fatalf("err = %v, want a retryable error within the hour", err)
	}

	r.now = occurred.Add(61 * time.Minute)
	if err := r.d.Handle(context.Background(), request("n1", expense)); !errors.As(err, &skip) {
		t.Fatalf("err = %v, want it given up (Skip) after an hour", err)
	}
}

func TestDispatch_NoEmailAddressSkipsEmail(t *testing.T) {
	r := newRig()
	s := r.settings.byUser[userA]
	s.Email = "" // not verified
	r.settings.byUser[userA] = s

	if err := r.d.Handle(context.Background(), request("n1", expense)); err != nil {
		t.Fatal(err)
	}
	if len(r.mail.sent) != 0 || len(r.push.sent) != 1 {
		t.Fatalf("push=%v mail=%v", r.push.sent, r.mail.sent)
	}
}

func TestDispatch_UnknownPersonIsSkippedAfterWaiting(t *testing.T) {
	r := newRig()
	delete(r.settings.byUser, userA)
	var skip kafkaconsume.Skip
	if err := r.d.Handle(context.Background(), request("n1", expense)); !errors.As(err, &skip) {
		t.Fatalf("err = %v, want Skip", err)
	}
}

func TestDispatch_PushOffWhenNotConfigured(t *testing.T) {
	r := newRig()
	r.d.Push = nil
	if err := r.d.Handle(context.Background(), request("n1", expense)); err != nil {
		t.Fatal(err)
	}
	if len(r.mail.sent) != 1 {
		t.Fatalf("mail=%v", r.mail.sent)
	}
}
