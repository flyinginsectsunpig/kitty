package fx

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	fxv1 "github.com/flyinginsectsunpig/kitty/services/pulse/gen/kitty/fx/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

type fakeSource struct {
	days  map[string]Day // keyed by the requested date ("latest" for nil)
	calls []string
	down  bool
}

func (f *fakeSource) Day(_ context.Context, date *time.Time) (Day, error) {
	key := "latest"
	if date != nil {
		key = date.Format(dateLayout)
	}
	f.calls = append(f.calls, key)
	if f.down {
		return Day{}, errors.New("frankfurter down")
	}
	day, ok := f.days[key]
	if !ok {
		return Day{}, errors.New("no fixture for " + key)
	}
	return day, nil
}

type fakeStore struct{ saved map[string]Day }

func (f *fakeStore) Lookup(_ context.Context, asked time.Time) (Day, bool, error) {
	day, ok := f.saved[asked.Format(dateLayout)]
	return day, ok, nil
}

func (f *fakeStore) Save(_ context.Context, asked time.Time, day Day) error {
	f.saved[asked.Format(dateLayout)] = day
	return nil
}

var today = date(2026, 11, 24)

func newService(src *fakeSource) (*Service, *fakeStore) {
	store := &fakeStore{saved: map[string]Day{}}
	return &Service{Source: src, Store: store, Now: func() time.Time { return today.Add(10 * time.Hour) }}, store
}

func get(t *testing.T, s *Service, base, quote, on string) (*fxv1.GetRateResponse, error) {
	t.Helper()
	return s.GetRate(context.Background(), &fxv1.GetRateRequest{Base: base, Quote: quote, Date: on})
}

func wantCode(t *testing.T, err error, code codes.Code) {
	t.Helper()
	if status.Code(err) != code {
		t.Fatalf("code = %v (%v), want %v", status.Code(err), err, code)
	}
}

func TestGetRate_HitDoesNotFetch(t *testing.T) {
	src := &fakeSource{}
	s, store := newService(src)
	store.saved["2026-11-20"] = ecbDay(date(2026, 11, 20), "19.1987")

	res, err := get(t, s, "EUR", "ZAR", "2026-11-20")
	if err != nil {
		t.Fatal(err)
	}
	if res.Rate != "19.1987" || res.RateDate != "2026-11-20" || res.Source != "ecb" {
		t.Fatalf("res = %+v", res)
	}
	if len(src.calls) != 0 {
		t.Fatalf("fetched %v on a hit", src.calls)
	}
}

func TestGetRate_MissFetchesAndSaves(t *testing.T) {
	src := &fakeSource{days: map[string]Day{"2026-11-20": ecbDay(date(2026, 11, 20), "19.1987")}}
	s, store := newService(src)

	if _, err := get(t, s, "EUR", "ZAR", "2026-11-20"); err != nil {
		t.Fatal(err)
	}
	if _, ok := store.saved["2026-11-20"]; !ok {
		t.Fatal("the fetched day wasn't saved")
	}
}

func TestGetRate_WeekendUsesFetchedEcbDate(t *testing.T) {
	src := &fakeSource{days: map[string]Day{"2026-11-22": ecbDay(date(2026, 11, 20), "19.1987")}}
	s, store := newService(src)

	res, err := get(t, s, "EUR", "ZAR", "2026-11-22")
	if err != nil {
		t.Fatal(err)
	}
	if res.RateDate != "2026-11-20" {
		t.Fatalf("rate_date = %s, want the Friday", res.RateDate)
	}
	if saved := store.saved["2026-11-22"]; !saved.Date.Equal(date(2026, 11, 20)) {
		t.Fatalf("saved 2026-11-22 → %s", saved.Date)
	}
}

func TestGetRate_UnseenDateFetchesEvenWhenOlderDatesStored(t *testing.T) {
	src := &fakeSource{days: map[string]Day{"2025-06-10": ecbDay(date(2025, 6, 10), "20.4")}}
	s, store := newService(src)
	store.saved["2024-01-05"] = ecbDay(date(2024, 1, 5), "20.0")

	res, err := get(t, s, "EUR", "ZAR", "2025-06-10")
	if err != nil {
		t.Fatal(err)
	}
	if res.Rate != "20.4" || len(src.calls) != 1 {
		t.Fatalf("res = %+v calls = %v", res, src.calls)
	}
}

func TestGetRate_FutureDateMeansToday(t *testing.T) {
	src := &fakeSource{days: map[string]Day{"latest": ecbDay(date(2026, 11, 24), "19.15")}}
	s, store := newService(src)

	if _, err := get(t, s, "EUR", "ZAR", "2027-01-01"); err != nil {
		t.Fatal(err)
	}
	if len(src.calls) != 1 || src.calls[0] != "latest" {
		t.Fatalf("calls = %v, want [latest]", src.calls)
	}
	if _, ok := store.saved["2026-11-24"]; !ok {
		t.Fatal("today's mapping wasn't saved")
	}
}

func TestGetRate_BeforeECBIsInvalidArgument(t *testing.T) {
	s, _ := newService(&fakeSource{})
	_, err := get(t, s, "EUR", "ZAR", "1998-12-31")
	wantCode(t, err, codes.InvalidArgument)
}

func TestGetRate_BadDateIsInvalidArgument(t *testing.T) {
	s, _ := newService(&fakeSource{})
	_, err := get(t, s, "EUR", "ZAR", "22/11/2026")
	wantCode(t, err, codes.InvalidArgument)
}

func TestGetRate_UnknownCurrencyIsInvalidArgument(t *testing.T) {
	src := &fakeSource{days: map[string]Day{"2026-11-20": ecbDay(date(2026, 11, 20), "19.1987")}}
	s, _ := newService(src)
	_, err := get(t, s, "XYZ", "ZAR", "2026-11-20")
	wantCode(t, err, codes.InvalidArgument)
}

func TestGetRate_SourceDownOnMissIsUnavailable(t *testing.T) {
	s, _ := newService(&fakeSource{down: true})
	_, err := get(t, s, "EUR", "ZAR", "2026-11-20")
	wantCode(t, err, codes.Unavailable)
}

func TestGetRate_OverGRPC(t *testing.T) {
	src := &fakeSource{days: map[string]Day{"2026-11-20": ecbDay(date(2026, 11, 20), "19.1987")}}
	s, _ := newService(src)

	lis := bufconn.Listen(1 << 20)
	srv := grpc.NewServer()
	fxv1.RegisterRatesServiceServer(srv, s)
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)

	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return lis.DialContext(ctx) }),
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	res, err := fxv1.NewRatesServiceClient(conn).GetRate(context.Background(),
		&fxv1.GetRateRequest{Base: "EUR", Quote: "ZAR", Date: "2026-11-20"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Rate != "19.1987" {
		t.Fatalf("rate = %s", res.Rate)
	}
}

func TestRefresh_SavesLatestUnderToday(t *testing.T) {
	src := &fakeSource{days: map[string]Day{"latest": ecbDay(date(2026, 11, 24), "19.15")}}
	s, store := newService(src)

	if err := s.RefreshToday(context.Background()); err != nil {
		t.Fatal(err)
	}
	if saved, ok := store.saved["2026-11-24"]; !ok || !saved.PerEUR["ZAR"].Equal(d("19.15")) {
		t.Fatalf("saved = %+v ok = %v", saved, ok)
	}
}
