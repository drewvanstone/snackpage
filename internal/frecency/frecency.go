// Package frecency scores bookmarks by combining recency and frequency.
package frecency

import (
	"math"
	"time"
)

// Score returns a non-negative float combining visit frequency with a
// piecewise decay on time since last visit. Brand-new and never-clicked
// bookmarks get a small constant floor so they don't permanently sink.
//
//	days_since = floor((now - lastVisit) / 24h)   (∞ if zero time)
//	decay      = 1.0   if days_since <= 1
//	           = 0.6   if days_since <= 7
//	           = 0.3   if days_since <= 30
//	           = 0.1   otherwise
//	score      = max(visitCount, 1) * decay
func Score(visitCount int, lastVisitAt, now time.Time) float64 {
	var decay float64
	switch {
	case lastVisitAt.IsZero():
		decay = 0.1
	default:
		days := math.Floor(now.Sub(lastVisitAt).Hours() / 24)
		switch {
		case days <= 1:
			decay = 1.0
		case days <= 7:
			decay = 0.6
		case days <= 30:
			decay = 0.3
		default:
			decay = 0.1
		}
	}
	count := float64(visitCount)
	if count < 1 {
		count = 1
	}
	return count * decay
}
