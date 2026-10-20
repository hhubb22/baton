package delivery

import (
	"math"
	"testing"
	"time"
)

func TestRetryDelayBounds(t *testing.T) {
	for _, minimum := range []time.Duration{0, time.Second, 5 * time.Second, time.Hour} {
		for _, attempt := range []int{-1, 0, 1, 2, 3, 8, math.MaxInt} {
			for _, fraction := range []float64{-1, 0, .5, 1, 2, math.NaN()} {
				got := delay(attempt, minimum, fraction)
				floor := min(max(minimum, time.Second), MaxDelay)
				if got < floor || got > MaxDelay {
					t.Fatalf("minimum=%v attempt=%d fraction=%v: %v", minimum, attempt, fraction, got)
				}
			}
		}
	}
}

func TestRetrySchedule(t *testing.T) {
	for _, tc := range []struct {
		minimum time.Duration
		want    []time.Duration
	}{
		{time.Second, []time.Duration{1, 2, 4, 8, 16, 30, 30}},
		{5 * time.Second, []time.Duration{5, 10, 20, 30, 30}},
	} {
		for i, seconds := range tc.want {
			upper := seconds * time.Second
			if got := delay(i+1, tc.minimum, 1); got != upper {
				t.Fatalf("minimum=%v attempt=%d: %v != %v", tc.minimum, i+1, got, upper)
			}
			lower := max(tc.minimum, upper-upper/5)
			if got := delay(i+1, tc.minimum, 0); got != lower {
				t.Fatalf("minimum=%v attempt=%d lower=%v != %v", tc.minimum, i+1, got, lower)
			}
		}
	}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if got := NextAttempt(now, 1, 5*time.Second); !got.Equal(now.Add(5 * time.Second)) {
		t.Fatalf("first prepare deadline: %v", got)
	}
}
