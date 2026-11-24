// Package notify delivers what the ledger asks to be told: Firebase push and email, per each person's settings, once
// per notification and channel.
package notify

import (
	"context"
	"errors"
	"fmt"

	notifyv1 "github.com/flyinginsectsunpig/kitty/services/pulse/gen/kitty/notify/v1"
	"github.com/flyinginsectsunpig/kitty/services/pulse/internal/kafkaconsume"
	"github.com/flyinginsectsunpig/kitty/services/pulse/internal/pgschema"
	"github.com/flyinginsectsunpig/kitty/services/pulse/internal/recurring"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/twmb/franz-go/pkg/kgo"
	"google.golang.org/protobuf/proto"
)

// SettingsTopic is the ledger's compacted topic of each person's delivery state, keyed by user id.
const SettingsTopic = "ledger.notify-settings"

// Channel is a way of telling someone.
type Channel string

const (
	ChannelPush  Channel = "push"
	ChannelEmail Channel = "email"
)

// Settings is a person's delivery state, as the ledger last published it.
type Settings struct {
	UserID                                                                        string
	Email                                                                         string // verified only; empty = no email
	ExpensePush, ExpenseEmail, PaymentPush, PaymentEmail, WeeklyPush, WeeklyEmail bool
	Tokens                                                                        []string
	Version                                                                       int64
}

const tables = `
CREATE TABLE IF NOT EXISTS pulse.notify_settings (
  user_id uuid PRIMARY KEY,
  email text NOT NULL,
  expense_push boolean NOT NULL, expense_email boolean NOT NULL,
  payment_push boolean NOT NULL, payment_email boolean NOT NULL,
  weekly_push boolean NOT NULL, weekly_email boolean NOT NULL,
  tokens text[] NOT NULL,
  version bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS pulse.deliveries (
  notification_id uuid NOT NULL,
  channel text NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, channel)
);`

// Store keeps settings and what has been delivered, in pulse's schema.
type Store struct{ pool *pgxpool.Pool }

func OpenStore(ctx context.Context, url string) (*Store, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("notify store: %w", err)
	}
	if err := pgschema.Ensure(ctx, pool); err != nil {
		pool.Close()
		return nil, err
	}
	if _, err := pool.Exec(ctx, tables); err != nil {
		pool.Close()
		return nil, fmt.Errorf("notify store: create tables: %w", err)
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() { s.pool.Close() }

// Upsert keeps a person's settings if they're newer than what's stored.
func (s *Store) Upsert(ctx context.Context, x Settings) error {
	tokens := x.Tokens
	if tokens == nil {
		tokens = []string{}
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO pulse.notify_settings (user_id, email, expense_push, expense_email, payment_push, payment_email,
		  weekly_push, weekly_email, tokens, version)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, expense_push = EXCLUDED.expense_push,
		  expense_email = EXCLUDED.expense_email, payment_push = EXCLUDED.payment_push, payment_email = EXCLUDED.payment_email,
		  weekly_push = EXCLUDED.weekly_push, weekly_email = EXCLUDED.weekly_email, tokens = EXCLUDED.tokens,
		  version = EXCLUDED.version
		WHERE pulse.notify_settings.version < EXCLUDED.version`,
		x.UserID, x.Email, x.ExpensePush, x.ExpenseEmail, x.PaymentPush, x.PaymentEmail, x.WeeklyPush, x.WeeklyEmail, tokens, x.Version)
	if err != nil {
		return fmt.Errorf("notify settings: upsert %s: %w", x.UserID, err)
	}
	return nil
}

// Get returns a person's settings, if the ledger has published them.
func (s *Store) Get(ctx context.Context, userID string) (Settings, bool, error) {
	x := Settings{UserID: userID}
	err := s.pool.QueryRow(ctx, `
		SELECT email, expense_push, expense_email, payment_push, payment_email, weekly_push, weekly_email, tokens, version
		FROM pulse.notify_settings WHERE user_id = $1`, userID).
		Scan(&x.Email, &x.ExpensePush, &x.ExpenseEmail, &x.PaymentPush, &x.PaymentEmail, &x.WeeklyPush, &x.WeeklyEmail, &x.Tokens, &x.Version)
	if errors.Is(err, pgx.ErrNoRows) {
		return Settings{}, false, nil
	}
	if err != nil {
		return Settings{}, false, fmt.Errorf("notify settings: get %s: %w", userID, err)
	}
	return x, true, nil
}

// Delivered reports whether a notification already went out on a channel.
func (s *Store) Delivered(ctx context.Context, notificationID string, ch Channel) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pulse.deliveries WHERE notification_id = $1 AND channel = $2)`,
		notificationID, string(ch)).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("deliveries: %w", err)
	}
	return exists, nil
}

// MarkDelivered records that a notification went out on a channel (after the provider accepted it).
func (s *Store) MarkDelivered(ctx context.Context, notificationID string, ch Channel) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO pulse.deliveries (notification_id, channel) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		notificationID, string(ch))
	if err != nil {
		return fmt.Errorf("deliveries: mark %s %s: %w", notificationID, ch, err)
	}
	return nil
}

// DecodeSettings reads the ledger's NotifySettingsChanged (schema-registry framing).
func DecodeSettings(value []byte) (Settings, error) {
	payload, err := kafkaconsume.StripConfluentHeader(value)
	if err != nil {
		return Settings{}, err
	}
	var m notifyv1.NotifySettingsChanged
	if err := proto.Unmarshal(payload, &m); err != nil {
		return Settings{}, fmt.Errorf("decode settings: %w", err)
	}
	return Settings{
		UserID: m.GetUserId(), Email: m.GetEmail(),
		ExpensePush: m.GetExpensePush(), ExpenseEmail: m.GetExpenseEmail(),
		PaymentPush: m.GetPaymentPush(), PaymentEmail: m.GetPaymentEmail(),
		WeeklyPush: m.GetWeeklyPush(), WeeklyEmail: m.GetWeeklyEmail(),
		Tokens: m.GetPushTokens(), Version: m.GetVersion(),
	}, nil
}

// ConsumeSettings keeps the store in step with the ledger's settings topic until ctx ends. Upserts are idempotent
// (newer versions win); an unreadable record, or one the database rejects outright, is skipped.
func ConsumeSettings(ctx context.Context, client *kgo.Client, store *Store) error {
	return kafkaconsume.Run(ctx, client, "notify settings", func(ctx context.Context, value []byte) error {
		s, err := DecodeSettings(value)
		if err != nil {
			return kafkaconsume.Skip{Err: err}
		}
		return recurring.RejectedAsSkip(store.Upsert(ctx, s))
	})
}
