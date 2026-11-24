package fx

import (
	"context"
	"flag"
	"log"
	"os"
	"testing"
	"time"

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
