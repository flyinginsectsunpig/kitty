// Package pgschema creates pulse's schema in the shared Postgres.
package pgschema

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Ensure creates schema "pulse" if it's missing. In production it already exists, owned by role "pulse", which may
// not create schemas — and CREATE SCHEMA IF NOT EXISTS checks that right even when the schema is there. So look first.
func Ensure(ctx context.Context, pool *pgxpool.Pool) error {
	var exists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pulse')`).Scan(&exists); err != nil {
		return fmt.Errorf("schema: %w", err)
	}
	if exists {
		return nil
	}
	if _, err := pool.Exec(ctx, `CREATE SCHEMA pulse`); err != nil {
		return fmt.Errorf("schema: create: %w", err)
	}
	return nil
}
