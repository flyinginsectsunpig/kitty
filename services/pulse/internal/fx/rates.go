// Package fx serves ECB exchange rates: fetched from Frankfurter, stored in Postgres, answered over gRPC.
package fx

import (
	"errors"
	"fmt"
	"time"

	"github.com/shopspring/decimal"
)

// ErrUnknownCurrency means the ECB published no rate for a currency on that day.
var ErrUnknownCurrency = errors.New("unknown currency")

// Day is one ECB publication: how much of each currency one euro buys. PerEUR never holds "EUR" (it is 1).
type Day struct {
	Date   time.Time
	PerEUR map[string]decimal.Decimal
}

// RatePlaces is how many decimal places a rate keeps (the ledger stores numeric(20,10)).
const RatePlaces = 10

// CrossRate is how much quote one unit of base buys: EUR→quote / EUR→base, rounded half-even to RatePlaces.
func CrossRate(day Day, base, quote string) (decimal.Decimal, error) {
	b, err := perEUR(day, base)
	if err != nil {
		return decimal.Decimal{}, err
	}
	q, err := perEUR(day, quote)
	if err != nil {
		return decimal.Decimal{}, err
	}
	if base == quote {
		return decimal.NewFromInt(1), nil
	}
	return q.DivRound(b, 20).RoundBank(RatePlaces), nil
}

func perEUR(day Day, currency string) (decimal.Decimal, error) {
	if currency == "EUR" {
		return decimal.NewFromInt(1), nil
	}
	r, ok := day.PerEUR[currency]
	if !ok {
		return decimal.Decimal{}, fmt.Errorf("%w: %q", ErrUnknownCurrency, currency)
	}
	return r, nil
}
