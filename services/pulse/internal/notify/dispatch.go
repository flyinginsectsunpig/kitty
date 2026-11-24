package notify

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	ledgerv1 "github.com/flyinginsectsunpig/kitty/services/pulse/gen/kitty/ledger/v1"
	notifyv1 "github.com/flyinginsectsunpig/kitty/services/pulse/gen/kitty/notify/v1"
	"github.com/flyinginsectsunpig/kitty/services/pulse/internal/kafkaconsume"
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
	Now        func() time.Time
	Wait       func(ctx context.Context, d time.Duration) error // sleeps; replaced in tests
}

// errRetry marks a delivery that failed for now (a provider busy or unreachable).
type errRetry struct{ err error }

func (e errRetry) Error() string { return e.err.Error() }
func (e errRetry) Unwrap() error { return e.err }

// Handle delivers one NotificationRequested. nil: done. Skip: will never be delivered. Other errors: try again.
func (d *Dispatcher) Handle(ctx context.Context, value []byte) error {
	payload, err := kafkaconsume.StripConfluentHeader(value)
	if err != nil {
		return kafkaconsume.Skip{Err: err}
	}
	var req notifyv1.NotificationRequested
	if err := proto.Unmarshal(payload, &req); err != nil {
		return kafkaconsume.Skip{Err: fmt.Errorf("decode request: %w", err)}
	}
	if req.GetNotificationId() == "" || req.GetUserId() == "" || req.GetOccurredAt() == nil {
		return kafkaconsume.Skip{Err: errors.New("request without notification id, user id or time")}
	}

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
	if err == nil {
		return nil
	}
	var r errRetry
	if !errors.As(err, &r) {
		return err // the database: retry until it's back, however long
	}
	elapsed := d.Now().Sub(req.GetOccurredAt().AsTime())
	if elapsed >= GiveUpAfter {
		return kafkaconsume.Skip{Err: fmt.Errorf("gave up after %s: %w", GiveUpAfter, err)}
	}
	// Back off as the failure drags on: a quarter of the time so far, at most five minutes.
	if err := d.Wait(ctx, min(max(elapsed/4, 0), 5*time.Minute)); err != nil {
		return err
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
	if IsTransient(err) {
		return errRetry{err}
	}
	slog.WarnContext(ctx, "email refused", "err", err)
	return nil
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
