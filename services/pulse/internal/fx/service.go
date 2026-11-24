package fx

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	fxv1 "github.com/flyinginsectsunpig/kitty/services/pulse/gen/kitty/fx/v1"
	"github.com/shopspring/decimal"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Source is where ECB days come from (Frankfurter in production).
type Source interface {
	Day(ctx context.Context, date *time.Time) (Day, error)
}

// Rates is where they're kept (the Postgres Store in production).
type Rates interface {
	Lookup(ctx context.Context, asked time.Time) (Stored, bool, error)
	Save(ctx context.Context, asked time.Time, day Day) error
}

// firstECBDate is the first day the ECB published euro reference rates.
var firstECBDate = time.Date(1999, 1, 4, 0, 0, 0, 0, time.UTC)

// Service answers GetRate from the store, fetching (and keeping) a date the first time anyone asks for it.
type Service struct {
	fxv1.UnimplementedRatesServiceServer
	Source Source
	Store  Rates
	Now    func() time.Time
}

func (s *Service) today() time.Time {
	n := s.Now().UTC()
	return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, time.UTC)
}

// GetRate is how much quote one unit of base bought on the ECB's rate for date (a future date means today).
func (s *Service) GetRate(ctx context.Context, req *fxv1.GetRateRequest) (*fxv1.GetRateResponse, error) {
	asked, err := time.Parse(dateLayout, req.GetDate())
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "date must be YYYY-MM-DD, got %q", req.GetDate())
	}
	if asked.Before(firstECBDate) {
		return nil, status.Errorf(codes.InvalidArgument, "the ECB has no rates before %s", firstECBDate.Format(dateLayout))
	}
	today := s.today()
	if asked.After(today) {
		asked = today
	}

	stored, ok, err := s.Store.Lookup(ctx, asked)
	if err != nil {
		slog.ErrorContext(ctx, "rate lookup failed", "date", asked.Format(dateLayout), "err", err)
		return nil, status.Error(codes.Unavailable, "rates are unavailable")
	}
	day := stored.Day
	if !ok || (asked.Before(today) && provisional(stored, asked)) {
		var on *time.Time
		if asked.Before(today) {
			on = &asked
		}
		fetched, err := s.fetch(ctx, asked, on)
		switch {
		case err == nil:
			day = fetched
		case ok: // re-checking a provisional answer failed: it still beats no rate at all
			slog.WarnContext(ctx, "rate re-check failed; using the earlier answer", "date", asked.Format(dateLayout), "err", err)
		default:
			slog.WarnContext(ctx, "rate fetch failed", "date", asked.Format(dateLayout), "err", err)
			return nil, status.Error(codes.Unavailable, "rates are unavailable")
		}
	}

	rate, err := CrossRate(day, req.GetBase(), req.GetQuote())
	if errors.Is(err, ErrUnknownCurrency) {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	return &fxv1.GetRateResponse{Rate: formatRate(rate), RateDate: day.Date.Format(dateLayout), Source: "ecb"}, nil
}

// provisional is an answer that may still change: an earlier ECB date, fetched before the asked day was over (the
// morning, before the ECB published that day's rates). Once the day is past, such an answer is fetched again.
func provisional(s Stored, asked time.Time) bool {
	return s.Date.Before(asked) && s.FetchedAt.Before(asked.AddDate(0, 0, 1))
}

// RefreshToday fetches the latest ECB day and records it as today's, so today's lookups catch up once the ECB
// publishes (around 16:00 CET).
func (s *Service) RefreshToday(ctx context.Context) error {
	_, err := s.fetch(ctx, s.today(), nil)
	return err
}

func (s *Service) fetch(ctx context.Context, asked time.Time, on *time.Time) (Day, error) {
	day, err := s.Source.Day(ctx, on)
	if err != nil {
		return Day{}, err
	}
	if err := s.Store.Save(ctx, asked, day); err != nil {
		return Day{}, err
	}
	return day, nil
}

// RefreshDaily runs RefreshToday now and then every interval until ctx ends. Failures are logged and retried next tick.
func RefreshDaily(ctx context.Context, s *Service, every time.Duration) {
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		if err := s.RefreshToday(ctx); err != nil {
			slog.WarnContext(ctx, "daily rate refresh failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// formatRate writes a rate as plain decimal text with no trailing zeros ("19.1987", "1").
func formatRate(r decimal.Decimal) string {
	s := r.StringFixed(RatePlaces)
	s = strings.TrimRight(s, "0")
	return strings.TrimSuffix(s, ".")
}
