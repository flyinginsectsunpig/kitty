package fx

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/flyinginsectsunpig/kitty/services/pulse/internal/pgschema"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

// tables are pulse's own corner of the shared Postgres. date_map records which ECB date each asked-for date resolved
// to, so a lookup never answers from a neighbouring stored date (which could be months stale).
const tables = `
CREATE TABLE IF NOT EXISTS pulse.ecb_rates (
  ecb_date date NOT NULL,
  currency char(3) NOT NULL,
  per_eur numeric(20,10) NOT NULL,
  PRIMARY KEY (ecb_date, currency)
);
CREATE TABLE IF NOT EXISTS pulse.date_map (
  asked_date date PRIMARY KEY,
  ecb_date date NOT NULL,
  fetched_at timestamptz NOT NULL
);`

// Store keeps ECB rates in Postgres.
type Store struct{ pool *pgxpool.Pool }

// OpenStore connects and creates pulse's schema if it's missing.
func OpenStore(ctx context.Context, url string) (*Store, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("store: %w", err)
	}
	if err := pgschema.Ensure(ctx, pool); err != nil {
		pool.Close()
		return nil, fmt.Errorf("store: %w", err)
	}
	if _, err := pool.Exec(ctx, tables); err != nil {
		pool.Close()
		return nil, fmt.Errorf("store: create tables: %w", err)
	}
	return &Store{pool: pool}, nil
}

// Close releases the connections.
func (s *Store) Close() { s.pool.Close() }

// Save stores day's rates and records that asked resolved to day.Date, in one transaction.
func (s *Store) Save(ctx context.Context, asked time.Time, day Day) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		batch := &pgx.Batch{}
		for currency, rate := range day.PerEUR {
			batch.Queue(`INSERT INTO pulse.ecb_rates (ecb_date, currency, per_eur) VALUES ($1, $2, $3::numeric)
				ON CONFLICT (ecb_date, currency) DO UPDATE SET per_eur = EXCLUDED.per_eur`,
				day.Date, currency, rate.String())
		}
		batch.Queue(`INSERT INTO pulse.date_map (asked_date, ecb_date, fetched_at) VALUES ($1, $2, now())
			ON CONFLICT (asked_date) DO UPDATE SET ecb_date = EXCLUDED.ecb_date, fetched_at = EXCLUDED.fetched_at`,
			asked, day.Date)
		if err := tx.SendBatch(ctx, batch).Close(); err != nil {
			return fmt.Errorf("store: save %s: %w", asked.Format(dateLayout), err)
		}
		return nil
	})
}

// Stored is what a date resolved to, and when that was fetched.
type Stored struct {
	Day
	FetchedAt time.Time
}

// Lookup returns the rates asked resolved to, if anyone asked for that date before.
func (s *Store) Lookup(ctx context.Context, asked time.Time) (Stored, bool, error) {
	var ecbDate, fetchedAt time.Time
	err := s.pool.QueryRow(ctx, `SELECT ecb_date, fetched_at FROM pulse.date_map WHERE asked_date = $1`, asked).
		Scan(&ecbDate, &fetchedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Stored{}, false, nil
	}
	if err != nil {
		return Stored{}, false, fmt.Errorf("store: lookup %s: %w", asked.Format(dateLayout), err)
	}

	rows, err := s.pool.Query(ctx, `SELECT currency, per_eur::text FROM pulse.ecb_rates WHERE ecb_date = $1`, ecbDate)
	if err != nil {
		return Stored{}, false, fmt.Errorf("store: rates for %s: %w", ecbDate.Format(dateLayout), err)
	}
	per := map[string]decimal.Decimal{}
	for rows.Next() {
		var currency, text string
		if err := rows.Scan(&currency, &text); err != nil {
			return Stored{}, false, err
		}
		r, err := decimal.NewFromString(text)
		if err != nil {
			return Stored{}, false, fmt.Errorf("store: rate for %s: %w", currency, err)
		}
		per[currency] = r
	}
	if err := rows.Err(); err != nil {
		return Stored{}, false, err
	}
	return Stored{Day: Day{Date: ecbDate.UTC(), PerEUR: per}, FetchedAt: fetchedAt.UTC()}, true, nil
}
