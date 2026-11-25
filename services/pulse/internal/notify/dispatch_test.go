package notify

import (
	"context"
	"errors"
	"fmt"
	"net/textproto"
	"slices"
	"strconv"
	"strings"
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

type fakePending struct{ byID map[string]PendingRequest }

func (f *fakePending) Defer(_ context.Context, id string, req []byte, occurredAt, next time.Time) error {
	f.byID[id] = PendingRequest{ID: id, Request: req, OccurredAt: occurredAt, NextAttempt: next}
	return nil
}
func (f *fakePending) Due(_ context.Context, now time.Time, _ int) ([]PendingRequest, error) {
	var due []PendingRequest
	for _, p := range f.byID {
		if !p.NextAttempt.After(now) {
			due = append(due, p)
		}
	}
	return due, nil
}
func (f *fakePending) Reschedule(_ context.Context, id string, next time.Time) error {
	p := f.byID[id]
	p.NextAttempt, p.Attempts = next, p.Attempts+1
	f.byID[id] = p
	return nil
}
func (f *fakePending) Drop(_ context.Context, id string) error {
	delete(f.byID, id)
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
	pending  *fakePending
	now      time.Time
}

func newRig() *rig {
	r := &rig{
		settings: &fakeSettings{byUser: map[string]Settings{userA: {
			UserID: userA, Email: "a@example.com", ExpensePush: true, ExpenseEmail: true, Tokens: []string{"t1"}, Version: 1,
		}}},
		push: &fakePusher{result: map[string]PushResult{}}, mail: &fakeMailer{}, ledger: &fakeLedger{},
		pending: &fakePending{byID: map[string]PendingRequest{}},
		now:     occurred.Add(time.Minute),
	}
	r.d = &Dispatcher{
		Deliveries: &fakeDeliveries{done: map[string]bool{}}, Settings: r.settings, Push: r.push, Mail: r.mail, Ledger: r.ledger, Pending: r.pending,
		Now: func() time.Time { return r.now }, Wait: func(context.Context, time.Duration) error { return nil },
	}
	return r
}

// Notification ids are UUIDs, as the ledger makes them.
func nid(n int) string { return fmt.Sprintf("c0000000-0000-0000-0000-%012d", n) }

func request(id string, kind notifyv1.NotificationRequested_Kind) []byte {
	if !strings.Contains(id, "-") {
		n, _ := strconv.Atoi(strings.TrimPrefix(id, "n"))
		id = nid(n)
	}
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

func TestDispatch_TransientFailureIsParkedNotBlocking(t *testing.T) {
	r := newRig()
	r.push.result["t1"] = PushRetry
	r.mail.err = &textproto.Error{Code: 451, Msg: "try later"}

	// nil: the topic moves on; the request waits in pending for the retry loop.
	if err := r.d.Handle(context.Background(), request("n1", expense)); err != nil {
		t.Fatalf("err = %v, want nil (parked)", err)
	}
	if _, ok := r.pending.byID[nid(1)]; !ok {
		t.Fatal("not parked")
	}

	// The next request (providers fine again) goes out straight away.
	r.push.result["t1"], r.mail.err = PushSent, nil
	if err := r.d.Handle(context.Background(), request("n2", expense)); err != nil {
		t.Fatal(err)
	}
	if len(r.push.sent) != 1 || len(r.mail.sent) != 1 {
		t.Fatalf("push=%v mail=%v", r.push.sent, r.mail.sent)
	}
}

func TestDispatch_RetrySendsOnlyTheChannelThatFailed(t *testing.T) {
	r := newRig()
	r.push.result["t1"] = PushRetry
	_ = r.d.Handle(context.Background(), request("n1", expense)) // email goes, push is parked
	if len(r.mail.sent) != 1 {
		t.Fatalf("mail=%v", r.mail.sent)
	}

	r.push.result["t1"] = PushSent
	r.now = r.now.Add(10 * time.Minute)
	if err := r.d.RetryDue(context.Background()); err != nil {
		t.Fatal(err)
	}

	if len(r.push.sent) != 1 || len(r.mail.sent) != 1 || len(r.pending.byID) != 0 {
		t.Fatalf("push=%v mail=%v pending=%v", r.push.sent, r.mail.sent, r.pending.byID)
	}
}

func TestDispatch_RetryKeepsTryingThenGivesUpAfterAnHour(t *testing.T) {
	r := newRig()
	r.push.result["t1"] = PushRetry
	_ = r.d.Handle(context.Background(), request("n1", expense))

	r.now = occurred.Add(20 * time.Minute)
	_ = r.d.RetryDue(context.Background())
	if p, ok := r.pending.byID[nid(1)]; !ok || p.Attempts != 1 || !p.NextAttempt.After(r.now) {
		t.Fatalf("pending = %+v, want rescheduled", r.pending.byID)
	}

	r.now = occurred.Add(61 * time.Minute)
	_ = r.d.RetryDue(context.Background())
	if len(r.pending.byID) != 0 || len(r.push.sent) != 0 {
		t.Fatalf("pending=%v sent=%v, want given up", r.pending.byID, r.push.sent)
	}
}

func TestDispatch_AlreadyAnHourOldIsNotParked(t *testing.T) {
	r := newRig()
	r.push.result["t1"] = PushRetry
	r.now = occurred.Add(2 * time.Hour) // the consumer was down; it's stale news now
	var skip kafkaconsume.Skip
	if err := r.d.Handle(context.Background(), request("n1", expense)); !errors.As(err, &skip) || len(r.pending.byID) != 0 {
		t.Fatalf("err=%v pending=%v", err, r.pending.byID)
	}
}

func TestDispatch_MalformedIdsAreSkipped(t *testing.T) {
	r := newRig()
	b, _ := proto.Marshal(&notifyv1.NotificationRequested{NotificationId: "not-a-uuid", UserId: userA, Kind: expense, OccurredAt: timestamppb.New(occurred)})
	var skip kafkaconsume.Skip
	if err := r.d.Handle(context.Background(), append([]byte{0, 0, 0, 0, 7, 0}, b...)); !errors.As(err, &skip) {
		t.Fatalf("err = %v, want Skip", err)
	}
}

// SMTP replies often echo the recipient ("<a@example.com>: Recipient address rejected"); logs get the code only.
func TestMailError_KeepsTheAddressOut(t *testing.T) {
	err := mailError(fmt.Errorf("smtp: rcpt: %w", &textproto.Error{Code: 450, Msg: "<a@example.com>: Recipient address rejected"}))
	if strings.Contains(err.Error(), "@") || !strings.Contains(err.Error(), "450") || !IsTransient(err) {
		t.Fatalf("err = %q (transient=%v)", err, IsTransient(err))
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

func TestDispatch_ReminderUsesReminderSettings(t *testing.T) {
	r := newRig()
	s := r.settings.byUser[userA]
	s.ReminderPush, s.ReminderEmail = false, true
	r.settings.byUser[userA] = s

	if err := r.d.Handle(context.Background(), request("n1", notifyv1.NotificationRequested_KIND_REMINDER)); err != nil {
		t.Fatal(err)
	}
	if len(r.push.sent) != 0 || len(r.mail.sent) != 1 {
		t.Fatalf("push=%v mail=%v", r.push.sent, r.mail.sent)
	}
}
