package fx

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/shopspring/decimal"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// testDB is a throwaway Postgres (the ledger's image) shared by this package's store tests.
var testDB string

func TestMain(m *testing.M) {
	flag.Parse() // testing.Short needs parsed flags
	if testing.Short() {
		os.Exit(m.Run())
	}
	ctx := context.Background()
	pg, err := postgres.Run(ctx, "pgvector/pgvector:pg17",
		postgres.WithDatabase("ledger"),
		testcontainers.WithWaitStrategy(wait.ForLog("database system is ready to accept connections").
			WithOccurrence(2).WithStartupTimeout(2*time.Minute)))
	if err != nil {
		log.Fatalf("postgres: %v", err)
	}
	testDB, err = pg.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		log.Fatalf("postgres url: %v", err)
	}
	code := m.Run()
	_ = testcontainers.TerminateContainer(pg)
	os.Exit(code)
}

func date(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 0, 0, 0, 0, time.UTC) }

func openStore(t *testing.T) *Store {
	t.Helper()
	if testing.Short() {
		t.Skip("needs Docker")
	}
	s, err := OpenStore(context.Background(), testDB)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

func ecbDay(on time.Time, zar string) Day {
	return Day{Date: on, PerEUR: map[string]decimal.Decimal{"ZAR": d(zar), "USD": d("1.099")}}
}

func TestStore_SaveThenLookup(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	if err := s.Save(ctx, date(2026, 11, 20), ecbDay(date(2026, 11, 20), "19.1987")); err != nil {
		t.Fatal(err)
	}
	got, ok, err := s.Lookup(ctx, date(2026, 11, 20))
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if !got.Date.Equal(date(2026, 11, 20)) || !got.PerEUR["ZAR"].Equal(d("19.1987")) || !got.PerEUR["USD"].Equal(d("1.099")) {
		t.Fatalf("got %+v", got)
	}
	if time.Since(got.FetchedAt) > time.Minute {
		t.Fatalf("fetched_at = %s, want about now", got.FetchedAt)
	}
}

func TestStore_AskedDateMapsToEarlierEcbDate(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	sunday := date(2026, 11, 22)
	if err := s.Save(ctx, sunday, ecbDay(date(2026, 11, 20), "19.1987")); err != nil {
		t.Fatal(err)
	}
	got, ok, err := s.Lookup(ctx, sunday)
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if !got.Date.Equal(date(2026, 11, 20)) {
		t.Fatalf("date = %s, want the Friday", got.Date)
	}
}

func TestStore_UnaskedDateIsNotFound(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	for _, on := range []time.Time{date(2024, 1, 5), date(2026, 11, 20)} {
		if err := s.Save(ctx, on, ecbDay(on, "19.1987")); err != nil {
			t.Fatal(err)
		}
	}
	// Dates either side are stored, but nobody asked for this one: answering from a neighbour could be months stale.
	if _, ok, err := s.Lookup(ctx, date(2026, 6, 10)); err != nil || ok {
		t.Fatalf("ok=%v err=%v, want not found", ok, err)
	}
}

// In production pulse connects as its own role, which owns schema "pulse" but may not create schemas — and
// CREATE SCHEMA IF NOT EXISTS checks that right even when the schema exists (deploy/compose/pulse-db-setup.sql).
func TestStore_OpensAsRestrictedRole(t *testing.T) {
	admin := openStore(t) // as the superuser: creates the schema, like pulse-db-setup does in compose
	ctx := context.Background()
	for _, sql := range []string{
		`DO $$ BEGIN CREATE ROLE limited LOGIN PASSWORD 'limited' NOSUPERUSER NOCREATEDB NOCREATEROLE;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`REVOKE CREATE ON DATABASE ledger FROM PUBLIC`,
		`ALTER SCHEMA pulse OWNER TO limited`,
		`ALTER TABLE pulse.ecb_rates OWNER TO limited`,
		`ALTER TABLE pulse.date_map OWNER TO limited`,
	} {
		if _, err := admin.pool.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	cfg, err := pgx.ParseConfig(testDB)
	if err != nil {
		t.Fatal(err)
	}
	url := fmt.Sprintf("postgres://limited:limited@%s:%d/ledger?sslmode=disable", cfg.Host, cfg.Port)

	s, err := OpenStore(ctx, url)
	if err != nil {
		t.Fatalf("a role that owns schema pulse but may not create schemas can't start pulse: %v", err)
	}
	s.Close()
}

func TestStore_SaveIsIdempotent(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	on := date(2025, 3, 14)
	if err := s.Save(ctx, on, ecbDay(on, "20.0000")); err != nil {
		t.Fatal(err)
	}
	if err := s.Save(ctx, on, ecbDay(on, "20.5")); err != nil {
		t.Fatal(err)
	}
	got, ok, err := s.Lookup(ctx, on)
	if err != nil || !ok || !got.PerEUR["ZAR"].Equal(d("20.5")) {
		t.Fatalf("got %+v ok=%v err=%v", got, ok, err)
	}
}
