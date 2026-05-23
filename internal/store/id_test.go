package store

import (
	"regexp"
	"testing"
)

func TestNewID(t *testing.T) {
	// Crockford base32: 0-9 + A-Z minus I L O U
	pattern := regexp.MustCompile(`^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$`)
	seen := make(map[string]bool)
	for i := 0; i < 1000; i++ {
		id := NewID()
		if !pattern.MatchString(id) {
			t.Fatalf("id %q does not match Crockford base32 8-char pattern", id)
		}
		if seen[id] {
			t.Fatalf("duplicate id %q within 1000 iterations", id)
		}
		seen[id] = true
	}
}
