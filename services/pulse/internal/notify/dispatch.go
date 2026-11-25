package notify

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/textproto"
	"regexp"
	"time"

	ledgerv1 "github.com/flyinginsectsunpig/kitty/services/pulse/gen/kitty/ledger/v1"
	notifyv1 "github.com/flyinginsectsunpig/kitty/services/pulse/gen/kitty/notify/v1"
	"github.com/flyinginsectsunpig/kitty/services/pulse/internal/kafkaconsume"
	"github.com/flyinginsectsunpig/kitty/services/pulse/internal/recurring"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"
)

// RequestsTopic is where the ledger asks for someone to be told something.
const RequestsTopic = "notifications.requested"

// GiveUpAfter is how long after the event a failing delivery keeps being retried. Later than that, the news is stale.
const GiveUpAfter = time.Hour

// settingsWaits is how many seconds a request waits for its person's settings (published by the ledger on another
// topic, so they can arrive a moment after the request).
const settingsWaits = 30

// Deliveries records what has gone out, so a redelivered request isn't sent twice.
type Deliveries interface {
	Delivered(ctx context.Context, notificationID string, ch Channel) (bool, error)
	MarkDelivered(ctx context.Context, notificationID string, ch Channel) error
}

// SettingsReader looks up a person's current settings.
type SettingsReader interface {
	Get(ctx context.Context, userID string) (Settings, bool, error)
}

// Ledger is what pulse asks of the ledger for notifications.
type Ledger interface {
	ForgetDevice(ctx context.Context, token string) error
	QueueWeeklySummaries(ctx context.Context, week string) error
}

// Dispatcher sends each requested notification on the channels its person has on, once per channel.
type Dispatcher struct {
	Deliveries Deliveries
	Settings   SettingsReader
	Push       Pusher // nil: push is off (no Firebase credentials)
	Mail       Mailer // nil: email is off (no SMTP host)
	Ledger     Ledger
	Pending    Pending // requests waiting for another attempt
	Now        func() time.Time
	Wait       func(ctx context.Context, d time.Duration) error // sleeps; replaced in tests
}

// Pending keeps requests whose delivery failed for now, so they wait off the topic instead of holding it up.
type Pending interface {
	Defer(ctx context.Context, id string, request []byte, occurredAt, next time.Time) error
	Due(ctx context.Context, now time.Time, limit int) ([]PendingRequest, error)
	Reschedule(ctx context.Context, id string, next time.Time) error
	Drop(ctx context.Context, id string) error
}

// errRetry marks a delivery that failed for now (a provider busy or unreachable).
type errRetry struct{ err error }

func (e errRetry) Error() string { return e.err.Error() }
func (e errRetry) Unwrap() error { return e.err }

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// Handle delivers one NotificationRequested from the topic. A delivery that fails for now is parked (and the topic
// moves on); RetryDue tries it again. nil: done or parked. Skip: will never be delivered. Other errors (the
// database): Run tries the record again.
func (d *Dispatcher) Handle(ctx context.Context, value []byte) error {
	req, err := decodeRequest(value)
	if err != nil {
		return kafkaconsume.Skip{Err: err}
	}
	err = d.deliver(ctx, req)
	var r errRetry
	if !errors.As(err, &r) {
		return err
	}
	occurred := req.GetOccurredAt().AsTime()
	if d.Now().Sub(occurred) >= GiveUpAfter {
		return kafkaconsume.Skip{Err: fmt.Errorf("gave up after %s: %w", GiveUpAfter, err)}
	}
	return d.Pending.Defer(ctx, req.GetNotificationId(), value, occurred, d.Now().Add(retryDelay(0)))
}

// RetryDue tries the parked requests whose time has come: delivered or hopeless ones are dropped, ones still failing
// wait longer, until an hour after the event.
func (d *Dispatcher) RetryDue(ctx context.Context) error {
	due, err := d.Pending.Due(ctx, d.Now(), 50)
	if err != nil {
		return err
	}
	for _, p := range due {
		req, err := decodeRequest(p.Request)
		if err == nil {
			err = d.deliver(ctx, req)
		}
		var r errRetry
		switch {
		case errors.As(err, &r) && d.Now().Sub(p.OccurredAt) < GiveUpAfter:
			err = d.Pending.Reschedule(ctx, p.ID, d.Now().Add(retryDelay(p.Attempts+1)))
		case errors.As(err, &r):
			slog.WarnContext(ctx, "notification given up", "notification", p.ID, "after", GiveUpAfter, "err", err)
			err = d.Pending.Drop(ctx, p.ID)
		case err == nil || errors.As(err, new(kafkaconsume.Skip)):
			err = d.Pending.Drop(ctx, p.ID)
		}
		if err != nil {
			return err // the database: next round
		}
	}
	return nil
}

// RunRetries calls RetryDue every interval until ctx ends.
func (d *Dispatcher) RunRetries(ctx context.Context, every time.Duration) {
	for {
		if err := d.RetryDue(ctx); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "notification retries failed; trying again", "err", err)
		}
		if Sleep(ctx, every) != nil {
			return
		}
	}
}

// retryDelay is 30 s doubling with each attempt, at most 10 minutes.
func retryDelay(attempts int) time.Duration {
	return min(30*time.Second<<min(attempts, 5), 10*time.Minute)
}

func decodeRequest(value []byte) (*notifyv1.NotificationRequested, error) {
	payload, err := kafkaconsume.StripConfluentHeader(value)
	if err != nil {
		return nil, err
	}
	var req notifyv1.NotificationRequested
	if err := proto.Unmarshal(payload, &req); err != nil {
		return nil, fmt.Errorf("decode request: %w", err)
	}
	if !uuidPattern.MatchString(req.GetNotificationId()) || !uuidPattern.MatchString(req.GetUserId()) || req.GetOccurredAt() == nil {
		return nil, errors.New("request without a valid notification id, user id or time")
	}
	return &req, nil
}

// deliver sends a request on each channel its person has on and hasn't had it on yet. errRetry: a provider failed
// for now. Skip: never deliverable. Other errors: the database.
func (d *Dispatcher) deliver(ctx context.Context, req *notifyv1.NotificationRequested) error {
	settings, err := d.settings(ctx, req.GetUserId())
	if err != nil {
		return err
	}
	push, email := wants(settings, req.GetKind())
	m := Message{Title: req.GetTitle(), Body: req.GetBody(), Link: req.GetLink()}
	id := req.GetNotificationId()

	var retry []error
	if push && d.Push != nil && len(settings.Tokens) > 0 {
		retry = append(retry, d.once(ctx, id, ChannelPush, func() error { return d.pushAll(ctx, settings.Tokens, m) }))
	}
	if email && d.Mail != nil && settings.Email != "" {
		retry = append(retry, d.once(ctx, id, ChannelEmail, func() error { return d.mail(ctx, settings.Email, m) }))
	}
	err = errors.Join(retry...)
	var r errRetry
	if err != nil && !errors.As(err, &r) {
		return recurring.RejectedAsSkip(err) // data the database will never take: skip; otherwise retry
	}
	return err
}

// settings waits briefly for a person's settings, then gives up on the request (Skip).
func (d *Dispatcher) settings(ctx context.Context, userID string) (Settings, error) {
	for i := 0; ; i++ {
		s, ok, err := d.Settings.Get(ctx, userID)
		if err != nil || ok {
			return s, err
		}
		if i == settingsWaits {
			return Settings{}, kafkaconsume.Skip{Err: fmt.Errorf("no notification settings for %s", userID)}
		}
		if err := d.Wait(ctx, time.Second); err != nil {
			return Settings{}, err
		}
	}
}

func wants(s Settings, kind notifyv1.NotificationRequested_Kind) (push, email bool) {
	switch kind {
	case notifyv1.NotificationRequested_KIND_EXPENSE_ADDED:
		return s.ExpensePush, s.ExpenseEmail
	case notifyv1.NotificationRequested_KIND_PAYMENT:
		return s.PaymentPush, s.PaymentEmail
	case notifyv1.NotificationRequested_KIND_WEEKLY_SUMMARY:
		return s.WeeklyPush, s.WeeklyEmail
	}
	return false, false
}

// once sends on a channel unless that already happened, and records it when the send is done with.
func (d *Dispatcher) once(ctx context.Context, id string, ch Channel, send func() error) error {
	done, err := d.Deliveries.Delivered(ctx, id, ch)
	if err != nil || done {
		return err
	}
	if err := send(); err != nil {
		return err
	}
	return d.Deliveries.MarkDelivered(ctx, id, ch)
}

// pushAll sends to every phone. It's done once any phone took it (retrying would repeat it on that one) or none can;
// it's retried only when no phone took it and one might later.
func (d *Dispatcher) pushAll(ctx context.Context, tokens []string, m Message) error {
	sent := 0
	var busy error
	for _, t := range tokens {
		res, err := d.Push.Push(ctx, t, m)
		switch res {
		case PushSent:
			sent++
		case PushDeadToken:
			if ferr := d.Ledger.ForgetDevice(ctx, t); ferr != nil {
				slog.WarnContext(ctx, "couldn't forget a dead phone", "err", ferr)
			}
		case PushRetry:
			busy = err
		default:
			slog.WarnContext(ctx, "push refused", "err", err)
		}
	}
	if sent == 0 && busy != nil {
		return errRetry{busy}
	}
	return nil
}

// mail sends the email; a refusal that won't change (a bad address) is logged and counted as done.
func (d *Dispatcher) mail(ctx context.Context, to string, m Message) error {
	err := d.Mail.Send(ctx, to, m)
	if err == nil {
		return nil
	}
	err = mailError(err)
	if IsTransient(err) {
		return errRetry{err}
	}
	slog.WarnContext(ctx, "email refused", "err", err)
	return nil
}

// mailError keeps an SMTP reply's code and drops its text, which often echoes the recipient's address (logs must not
// hold email addresses). Other errors (network) don't name the recipient and pass through.
func mailError(err error) error {
	var tp *textproto.Error
	if errors.As(err, &tp) {
		return &textproto.Error{Code: tp.Code, Msg: fmt.Sprintf("smtp reply %d", tp.Code)}
	}
	return err
}

// Sleep waits d, or until ctx ends.
func Sleep(ctx context.Context, d time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

type ledgerClient struct{ rpc ledgerv1.NotifyServiceClient }

// NewLedger calls the ledger's NotifyService over conn (which carries pulse's service token).
func NewLedger(conn grpc.ClientConnInterface) Ledger {
	return ledgerClient{rpc: ledgerv1.NewNotifyServiceClient(conn)}
}

func (c ledgerClient) ForgetDevice(ctx context.Context, token string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err := c.rpc.ForgetDevice(ctx, &ledgerv1.ForgetDeviceRequest{Token: token})
	return err
}

func (c ledgerClient) QueueWeeklySummaries(ctx context.Context, week string) error {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	_, err := c.rpc.QueueWeeklySummaries(ctx, &ledgerv1.QueueWeeklySummariesRequest{Week: week})
	return err
}
