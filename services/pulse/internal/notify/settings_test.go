package notify

import (
	"context"
	"flag"
	"log"
	"os"
	"slices"
	"testing"
	"time"

	notifyv1 "github.com/flyinginsectsunpig/kitty/services/pulse/gen/kitty/notify/v1"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
	"google.golang.org/protobuf/proto"
)

// A throwaway Postgres (and, for the email test, Mailpit) for this package (skipped with -short).
var testDB string

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
	stopMailpit := startMailpit(ctx)
	code := m.Run()
	stopMailpit()
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

const userA = "d0000000-0000-0000-0000-000000000001"

func TestSettings_NewerVersionWins(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	if err := s.Upsert(ctx, Settings{UserID: userA, ExpensePush: true, Version: 5}); err != nil {
		t.Fatal(err)
	}
	if err := s.Upsert(ctx, Settings{UserID: userA, ExpensePush: false, Version: 4}); err != nil {
		t.Fatal(err)
	}
	got, ok, err := s.Get(ctx, userA)
	if err != nil || !ok || !got.ExpensePush || got.Version != 5 {
		t.Fatalf("got %+v ok=%v err=%v", got, ok, err)
	}
}

func TestSettings_TokensAndEmailRoundTrip(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	id := "d0000000-0000-0000-0000-000000000002"
	in := Settings{UserID: id, Email: "a@example.com", PaymentEmail: true, WeeklyPush: true, ReminderEmail: true, Tokens: []string{"t1", "t2"}, Version: 1}
	if err := s.Upsert(ctx, in); err != nil {
		t.Fatal(err)
	}
	got, ok, err := s.Get(ctx, id)
	if err != nil || !ok || got.Email != "a@example.com" || !got.PaymentEmail || !got.WeeklyPush || !got.ReminderEmail || got.ReminderPush || !slices.Equal(got.Tokens, []string{"t1", "t2"}) {
		t.Fatalf("got %+v ok=%v err=%v", got, ok, err)
	}
	if _, ok, _ := s.Get(ctx, "d0000000-0000-0000-0000-00000000ffff"); ok {
		t.Fatal("an unknown person has settings")
	}
}

func TestDeliveries_MarkThenDelivered(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	id := "e0000000-0000-0000-0000-000000000001"
	if done, err := s.Delivered(ctx, id, ChannelPush); err != nil || done {
		t.Fatalf("done=%v err=%v before marking", done, err)
	}
	if err := s.MarkDelivered(ctx, id, ChannelPush); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkDelivered(ctx, id, ChannelPush); err != nil { // marking twice is harmless
		t.Fatal(err)
	}
	if done, _ := s.Delivered(ctx, id, ChannelPush); !done {
		t.Fatal("not recorded")
	}
	if done, _ := s.Delivered(ctx, id, ChannelEmail); done {
		t.Fatal("email counted as delivered")
	}
}

func TestPending_DeferDueRescheduleDrop(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	id := "f0000000-0000-0000-0000-000000000001"
	at := time.Date(2026, 11, 25, 10, 0, 0, 0, time.UTC)
	if err := s.Defer(ctx, id, []byte("req"), at, at.Add(30*time.Second)); err != nil {
		t.Fatal(err)
	}
	if due, _ := s.Due(ctx, at.Add(10*time.Second), 10); len(due) != 0 {
		t.Fatalf("due too early: %+v", due)
	}
	due, err := s.Due(ctx, at.Add(time.Minute), 10)
	if err != nil || len(due) != 1 || due[0].ID != id || string(due[0].Request) != "req" || due[0].Attempts != 0 || !due[0].OccurredAt.Equal(at) {
		t.Fatalf("due=%+v err=%v", due, err)
	}
	if err := s.Reschedule(ctx, id, at.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if due, _ := s.Due(ctx, at.Add(time.Minute), 10); len(due) != 0 {
		t.Fatalf("rescheduled but still due: %+v", due)
	}
	due, _ = s.Due(ctx, at.Add(2*time.Hour), 10)
	if len(due) != 1 || due[0].Attempts != 1 {
		t.Fatalf("due=%+v", due)
	}
	if err := s.Drop(ctx, id); err != nil {
		t.Fatal(err)
	}
	if due, _ := s.Due(ctx, at.Add(2*time.Hour), 10); len(due) != 0 {
		t.Fatalf("dropped but still due: %+v", due)
	}
}

func TestDeliveries_PruneForgetsOnlyOldOnes(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	old, recent := "e0000000-0000-0000-0000-0000000000a1", "e0000000-0000-0000-0000-0000000000a2"
	_ = s.MarkDelivered(ctx, old, ChannelPush)
	_ = s.MarkDelivered(ctx, recent, ChannelPush)
	if _, err := s.pool.Exec(ctx, `UPDATE pulse.deliveries SET delivered_at = now() - interval '8 days' WHERE notification_id = $1`, old); err != nil {
		t.Fatal(err)
	}

	if err := s.PruneDeliveries(ctx, time.Now().Add(-7*24*time.Hour)); err != nil {
		t.Fatal(err)
	}

	if done, _ := s.Delivered(ctx, old, ChannelPush); done {
		t.Fatal("old delivery kept")
	}
	if done, _ := s.Delivered(ctx, recent, ChannelPush); !done {
		t.Fatal("recent delivery pruned")
	}
}

func TestDecodeSettings_FromTheLedgersMessage(t *testing.T) {
	b, _ := proto.Marshal(&notifyv1.NotifySettingsChanged{UserId: userA, Email: "x@example.com", ExpensePush: true, PushTokens: []string{"t"}, Version: 3})
	got, err := DecodeSettings(append([]byte{0, 0, 0, 0, 4, 0}, b...))
	if err != nil || got.UserID != userA || got.Email != "x@example.com" || !got.ExpensePush || got.Version != 3 || len(got.Tokens) != 1 {
		t.Fatalf("got %+v err=%v", got, err)
	}
}
