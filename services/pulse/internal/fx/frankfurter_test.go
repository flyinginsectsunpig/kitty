package fx

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A real response from api.frankfurter.dev/v1/2026-11-22 (a Sunday), trimmed: the ECB date it used is the Friday.
const sundayBody = `{"amount":1.0,"base":"EUR","date":"2026-11-20","rates":{"USD":1.099,"ZAR":19.1987}}`

func frankfurter(t *testing.T, handler http.HandlerFunc) (Frankfurter, *[]string) {
	t.Helper()
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	return Frankfurter{BaseURL: srv.URL + "/v1", HTTP: srv.Client()}, &paths
}

func TestFrankfurter_DayParsesDateAndRates(t *testing.T) {
	f, paths := frankfurter(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(sundayBody)) })
	sunday := time.Date(2026, 11, 22, 0, 0, 0, 0, time.UTC)

	got, err := f.Day(context.Background(), &sunday)
	if err != nil {
		t.Fatal(err)
	}
	if (*paths)[0] != "/v1/2026-11-22" {
		t.Fatalf("path = %s", (*paths)[0])
	}
	if !got.Date.Equal(time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("date = %s, want the ECB date 2026-11-20", got.Date)
	}
	if !got.PerEUR["ZAR"].Equal(d("19.1987")) || !got.PerEUR["USD"].Equal(d("1.099")) {
		t.Fatalf("rates = %v", got.PerEUR)
	}
}

func TestFrankfurter_Latest(t *testing.T) {
	f, paths := frankfurter(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(sundayBody)) })
	if _, err := f.Day(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if (*paths)[0] != "/v1/latest" {
		t.Fatalf("path = %s", (*paths)[0])
	}
}

func TestFrankfurter_Non200IsError(t *testing.T) {
	f, _ := frankfurter(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) })
	if _, err := f.Day(context.Background(), nil); err == nil {
		t.Fatal("want an error for a 503")
	}
}
