// Package recurring adds recurring expenses: pulse keeps a copy of the ledger's schedules (from Kafka) and asks the
// ledger, over gRPC, to add each period when it falls due.
package recurring

import "time"

// Frequency is how often a schedule repeats.
type Frequency int

const (
	Weekly Frequency = iota + 1
	Monthly
)

// Rule repeats from its start date: weekly on that weekday, or monthly on that day of the month. Monthly on the
// 29th–31st lands on the last day of shorter months, without carrying forward (31 Jan, 28 Feb, 31 Mar). The ledger's
// C# copy runs the same fixture (contracts/fixtures/recurrence.json).
type Rule struct {
	Frequency Frequency
	StartsOn  time.Time // a UTC date
}

// Between is every occurrence in [from, to], oldest first, never before the start date.
func Between(r Rule, from, to time.Time) []time.Time {
	var out []time.Time
	if from.Before(r.StartsOn) {
		from = r.StartsOn
	}
	if from.After(to) {
		return out
	}
	for k := firstIndexNear(r, from); ; k++ {
		d := occurrence(r, k)
		if d.After(to) {
			return out
		}
		if !d.Before(from) {
			out = append(out, d)
		}
	}
}

// IsOccurrence reports whether date is one of the rule's due dates.
func IsOccurrence(r Rule, date time.Time) bool {
	return !date.Before(r.StartsOn) && len(Between(r, date, date)) == 1
}

// NextCycleStart is the first day of the cycle after the one holding period: the next month's 1st, or the next Monday.
func NextCycleStart(f Frequency, period time.Time) time.Time {
	if f == Monthly {
		return time.Date(period.Year(), period.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, 1, 0)
	}
	return period.AddDate(0, 0, 8-isoWeekday(period))
}

func occurrence(r Rule, k int) time.Time {
	if r.Frequency == Weekly {
		return r.StartsOn.AddDate(0, 0, 7*k)
	}
	month := time.Date(r.StartsOn.Year(), r.StartsOn.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, k, 0)
	return month.AddDate(0, 0, min(r.StartsOn.Day(), daysIn(month))-1)
}

// firstIndexNear is an occurrence index at or just before date, so loops don't walk from the start.
func firstIndexNear(r Rule, date time.Time) int {
	if r.Frequency == Weekly {
		return max(0, int(date.Sub(r.StartsOn).Hours()/24)/7)
	}
	return max(0, (date.Year()-r.StartsOn.Year())*12+int(date.Month())-int(r.StartsOn.Month())-1)
}

func daysIn(month time.Time) int {
	return month.AddDate(0, 1, -1).Day()
}

func isoWeekday(d time.Time) int {
	if d.Weekday() == time.Sunday {
		return 7
	}
	return int(d.Weekday())
}
