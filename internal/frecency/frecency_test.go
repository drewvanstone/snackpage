package frecency_test

import (
	"testing"
	"time"

	"github.com/drewvanstone/snackpage/internal/frecency"
)

func TestScore(t *testing.T) {
	now := time.Date(2026, 5, 23, 12, 0, 0, 0, time.UTC)

	cases := []struct {
		name        string
		visitCount  int
		lastVisitAt time.Time
		want        float64
	}{
		{"never visited", 0, time.Time{}, 0.1},
		{"visited today", 1, now.Add(-1 * time.Hour), 1.0},
		{"visited 1 day ago", 5, now.Add(-24 * time.Hour), 5.0},
		{"visited 3 days ago", 5, now.Add(-3 * 24 * time.Hour), 3.0},
		{"visited 10 days ago", 5, now.Add(-10 * 24 * time.Hour), 1.5},
		{"visited 60 days ago", 5, now.Add(-60 * 24 * time.Hour), 0.5},
		{"high count distant", 100, now.Add(-90 * 24 * time.Hour), 10.0},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := frecency.Score(tc.visitCount, tc.lastVisitAt, now)
			if got != tc.want {
				t.Errorf("Score(%d, %v) = %f; want %f",
					tc.visitCount, tc.lastVisitAt, got, tc.want)
			}
		})
	}
}
