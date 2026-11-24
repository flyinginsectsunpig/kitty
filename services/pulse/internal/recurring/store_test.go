package recurring

import (
	"context"
	"flag"
	"log"
	"os"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/modules/redpanda"
	"github.com/testcontainers/testcontainers-go/wait"
)

// A throwaway Postgres and Redpanda for this package's store and consumer tests (skipped with -short).
var (
	testDB    string
	testKafka string
)

func TestMain(m *testing.M) {
	flag.Parse()
	if testing.Short() {
		os.Exit(m.Run())
	}
	ctx := context.Background()
	pg, err := postgres.Run(ctx, "pgvector/pgvector:pg17", postgres.WithDatabase("ledger"),
		testcontainers.WithWaitStrategy(wait.ForLog("database system is ready to accept connections").
			WithOccurrence(2).WithStartupTimeout(2*time.Minute)))
	if err != nil {
		log.Fatalf("postgres: %v", err)
	}
	if testDB, err = pg.ConnectionString(ctx, "sslmode=disable"); err != nil {
		log.Fatalf("postgres url: %v", err)
	}
	rp, err := redpanda.Run(ctx, "docker.redpanda.com/redpandadata/redpanda:v26.2.6", redpanda.WithAutoCreateTopics())
	if err != nil {
		log.Fatalf("redpanda: %v", err)
	}
	if testKafka, err = rp.KafkaSeedBroker(ctx); err != nil {
		log.Fatalf("redpanda broker: %v", err)
	}
	code := m.Run()
	_ = testcontainers.TerminateContainer(rp)
	_ = testcontainers.TerminateContainer(pg)
	os.Exit(code)
}

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

func sched(id string, version int32) Schedule {
	return Schedule{
		ID: id, GroupID: "c0000000-0000-0000-0000-000000000001", Rule: Rule{Frequency: Monthly, StartsOn: date(2026, 11, 1)},
		NotBefore: date(2026, 11, 1), Version: version,
	}
}

func date(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 0, 0, 0, 0, time.UTC) }

func liveByID(t *testing.T, s *Store, id string) (Schedule, bool) {
	t.Helper()
	live, err := s.Live(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, x := range live {
		if x.ID == id {
			return x, true
		}
	}
	return Schedule{}, false
}

func TestStore_OlderVersionIsIgnored(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	newer := sched("a0000000-0000-0000-0000-000000000001", 3)
	newer.Rule.Frequency = Weekly
	if err := s.Upsert(ctx, newer); err != nil {
		t.Fatal(err)
	}
	if err := s.Upsert(ctx, sched(newer.ID, 2)); err != nil {
		t.Fatal(err)
	}
	got, ok := liveByID(t, s, newer.ID)
	if !ok || got.Rule.Frequency != Weekly || got.Version != 3 {
		t.Fatalf("got %+v ok=%v", got, ok)
	}
}

func TestStore_DeletedAndPausedAreNotLive(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	deleted, paused := sched("a0000000-0000-0000-0000-000000000002", 1), sched("a0000000-0000-0000-0000-000000000003", 1)
	deleted.Deleted, paused.Paused = true, true
	for _, x := range []Schedule{deleted, paused} {
		if err := s.Upsert(ctx, x); err != nil {
			t.Fatal(err)
		}
	}
	if _, ok := liveByID(t, s, deleted.ID); ok {
		t.Fatal("a deleted schedule is live")
	}
	if _, ok := liveByID(t, s, paused.ID); ok {
		t.Fatal("a paused schedule is live")
	}
}

func TestStore_UpsertKeepsLastAdded(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	x := sched("a0000000-0000-0000-0000-000000000004", 1)
	if err := s.Upsert(ctx, x); err != nil {
		t.Fatal(err)
	}
	if err := s.SetLastAdded(ctx, x.ID, date(2026, 11, 1)); err != nil {
		t.Fatal(err)
	}
	x.Version = 2
	x.EndsOn = ptr(date(2027, 6, 1))
	if err := s.Upsert(ctx, x); err != nil {
		t.Fatal(err)
	}
	got, _ := liveByID(t, s, x.ID)
	if got.LastAdded == nil || !got.LastAdded.Equal(date(2026, 11, 1)) || got.EndsOn == nil {
		t.Fatalf("got %+v", got)
	}
}

func ptr[T any](v T) *T { return &v }
