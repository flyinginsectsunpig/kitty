package fx

import (
	"errors"
	"testing"
	"time"

	"github.com/shopspring/decimal"
)

func d(s string) decimal.Decimal { return decimal.RequireFromString(s) }

func day(rates map[string]string) Day {
	per := map[string]decimal.Decimal{}
	for k, v := range rates {
		per[k] = d(v)
	}
	return Day{Date: time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC), PerEUR: per}
}

func assertRate(t *testing.T, got decimal.Decimal, err error, want string) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !got.Equal(d(want)) {
		t.Fatalf("rate = %s, want %s", got, want)
	}
}

func TestCrossRate_EURBase(t *testing.T) {
	got, err := CrossRate(day(map[string]string{"ZAR": "19.1987"}), "EUR", "ZAR")
	assertRate(t, got, err, "19.1987")
}

func TestCrossRate_Cross(t *testing.T) {
	got, err := CrossRate(day(map[string]string{"USD": "1.099", "ZAR": "19.1987"}), "USD", "ZAR")
	assertRate(t, got, err, "17.4692447680")
}

func TestCrossRate_ToEUR(t *testing.T) {
	got, err := CrossRate(day(map[string]string{"ZAR": "19.1987"}), "ZAR", "EUR")
	assertRate(t, got, err, "0.0520868600")
}

func TestCrossRate_Same(t *testing.T) {
	got, err := CrossRate(day(map[string]string{"ZAR": "19.1987"}), "ZAR", "ZAR")
	assertRate(t, got, err, "1")
}

func TestCrossRate_Unknown(t *testing.T) {
	_, err := CrossRate(day(map[string]string{"ZAR": "19.1987"}), "XYZ", "ZAR")
	if !errors.Is(err, ErrUnknownCurrency) {
		t.Fatalf("err = %v, want ErrUnknownCurrency", err)
	}
}
