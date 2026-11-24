package recurring

import (
	"context"
	"fmt"
	"time"

	"github.com/flyinginsectsunpig/kitty/services/pulse/internal/pgschema"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Schedule is pulse's copy of a ledger schedule's timing, plus the last period pulse added.
type Schedule struct {
	ID, GroupID string
	Rule        Rule
	EndsOn      *time.Time
	NotBefore   time.Time
	Paused      bool
	Deleted     bool
	Version     int32
	LastAdded   *time.Time
}

const scheduleTable = `
CREATE TABLE IF NOT EXISTS pulse.schedules (
  schedule_id uuid PRIMARY KEY,
  group_id uuid NOT NULL,
  frequency text NOT NULL,
  starts_on date NOT NULL,
  ends_on date,
  not_before date NOT NULL,
  paused boolean NOT NULL,
  deleted boolean NOT NULL,
  version integer NOT NULL,
  last_added date
);`

// Store keeps the schedules in pulse's schema.
type Store struct{ pool *pgxpool.Pool }

// OpenStore connects and creates the table if it's missing.
func OpenStore(ctx context.Context, url string) (*Store, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("schedules: %w", err)
	}
	if err := pgschema.Ensure(ctx, pool); err != nil {
		pool.Close()
		return nil, err
	}
	if _, err := pool.Exec(ctx, scheduleTable); err != nil {
		pool.Close()
		return nil, fmt.Errorf("schedules: create table: %w", err)
	}
	return &Store{pool: pool}, nil
}

// Close releases the connections.
func (s *Store) Close() { s.pool.Close() }

// Upsert stores a schedule's state if it is newer than what's kept. It never changes last_added.
func (s *Store) Upsert(ctx context.Context, x Schedule) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO pulse.schedules (schedule_id, group_id, frequency, starts_on, ends_on, not_before, paused, deleted, version)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (schedule_id) DO UPDATE SET
		  group_id = EXCLUDED.group_id, frequency = EXCLUDED.frequency, starts_on = EXCLUDED.starts_on,
		  ends_on = EXCLUDED.ends_on, not_before = EXCLUDED.not_before, paused = EXCLUDED.paused,
		  deleted = EXCLUDED.deleted, version = EXCLUDED.version
		WHERE pulse.schedules.version < EXCLUDED.version`,
		x.ID, x.GroupID, frequencyName(x.Rule.Frequency), x.Rule.StartsOn, x.EndsOn, x.NotBefore, x.Paused, x.Deleted, x.Version)
	if err != nil {
		return fmt.Errorf("schedules: upsert %s: %w", x.ID, err)
	}
	return nil
}

// Live is every schedule that may add periods: not deleted, not paused.
func (s *Store) Live(ctx context.Context) ([]Schedule, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT schedule_id::text, group_id::text, frequency, starts_on, ends_on, not_before, version, last_added
		FROM pulse.schedules WHERE NOT deleted AND NOT paused ORDER BY schedule_id`)
	if err != nil {
		return nil, fmt.Errorf("schedules: live: %w", err)
	}
	defer rows.Close()
	var out []Schedule
	for rows.Next() {
		var x Schedule
		var freq string
		if err := rows.Scan(&x.ID, &x.GroupID, &freq, &x.Rule.StartsOn, &x.EndsOn, &x.NotBefore, &x.Version, &x.LastAdded); err != nil {
			return nil, err
		}
		if x.Rule.Frequency, err = parseFrequency(freq); err != nil {
			return nil, err
		}
		x.Rule.StartsOn, x.NotBefore = x.Rule.StartsOn.UTC(), x.NotBefore.UTC()
		out = append(out, x)
	}
	return out, rows.Err()
}

// SetLastAdded records the latest period pulse has dealt with for a schedule.
func (s *Store) SetLastAdded(ctx context.Context, id string, period time.Time) error {
	_, err := s.pool.Exec(ctx, `UPDATE pulse.schedules SET last_added = GREATEST(COALESCE(last_added, $2), $2) WHERE schedule_id = $1`, id, period)
	if err != nil {
		return fmt.Errorf("schedules: last added %s: %w", id, err)
	}
	return nil
}

func frequencyName(f Frequency) string {
	if f == Weekly {
		return "weekly"
	}
	return "monthly"
}

func parseFrequency(s string) (Frequency, error) {
	switch s {
	case "weekly":
		return Weekly, nil
	case "monthly":
		return Monthly, nil
	}
	return 0, fmt.Errorf("schedules: unknown frequency %q", s)
}
