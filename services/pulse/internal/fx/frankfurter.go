package fx

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/shopspring/decimal"
)

const dateLayout = "2006-01-02"

// Frankfurter reads ECB reference rates from the Frankfurter API (free, no key).
type Frankfurter struct {
	BaseURL string // e.g. https://api.frankfurter.dev/v1
	HTTP    *http.Client
}

// Day fetches the rates for date (nil means the latest). Frankfurter answers with the ECB date it actually used:
// for a weekend or holiday, the working day before.
func (f Frankfurter) Day(ctx context.Context, date *time.Time) (Day, error) {
	path := "latest"
	if date != nil {
		path = date.Format(dateLayout)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.BaseURL+"/"+path, nil)
	if err != nil {
		return Day{}, err
	}
	res, err := f.HTTP.Do(req)
	if err != nil {
		return Day{}, fmt.Errorf("frankfurter: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return Day{}, fmt.Errorf("frankfurter: %s for /%s", res.Status, path)
	}

	var body struct {
		Base  string                 `json:"base"`
		Date  string                 `json:"date"`
		Rates map[string]json.Number `json:"rates"`
	}
	dec := json.NewDecoder(res.Body)
	dec.UseNumber() // rates stay exact decimal text, never float64
	if err := dec.Decode(&body); err != nil {
		return Day{}, fmt.Errorf("frankfurter: %w", err)
	}
	if body.Base != "EUR" {
		return Day{}, fmt.Errorf("frankfurter: base %q, want EUR", body.Base)
	}
	ecbDate, err := time.Parse(dateLayout, body.Date)
	if err != nil {
		return Day{}, fmt.Errorf("frankfurter: date: %w", err)
	}

	per := make(map[string]decimal.Decimal, len(body.Rates))
	for currency, n := range body.Rates {
		r, err := decimal.NewFromString(n.String())
		if err != nil {
			return Day{}, fmt.Errorf("frankfurter: rate for %s: %w", currency, err)
		}
		per[currency] = r
	}
	return Day{Date: ecbDate, PerEUR: per}, nil
}

// NewFrankfurter is the production client: a 10 s timeout per request.
func NewFrankfurter(baseURL string) Frankfurter {
	return Frankfurter{BaseURL: baseURL, HTTP: &http.Client{Timeout: 10 * time.Second}}
}
