package store

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadState_MissingFile(t *testing.T) {
	dir := t.TempDir()
	got, err := loadState(filepath.Join(dir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if got.Version != 1 {
		t.Errorf("Version = %d; want 1", got.Version)
	}
	if len(got.Stats) != 0 {
		t.Errorf("len Stats = %d; want 0", len(got.Stats))
	}
}

func TestLoadState_RejectsInconsistentStats(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{
			name: "negative count",
			raw:  `{"version":1,"stats":{"B7K3M2QA":{"visit_count":-1}}}`,
		},
		{
			name: "visit without timestamp",
			raw:  `{"version":1,"stats":{"B7K3M2QA":{"visit_count":1}}}`,
		},
		{
			name: "timestamp without visit",
			raw:  `{"version":1,"stats":{"B7K3M2QA":{"visit_count":0,"last_visit_at":"2026-05-23T17:12:33Z"}}}`,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "state.json")
			if err := os.WriteFile(path, []byte(tc.raw), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := loadState(path); !errors.Is(err, ErrValidation) {
				t.Fatalf("loadState error = %v; want ErrValidation", err)
			}
		})
	}
}

func TestSaveAndLoadState_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")

	original := &StateFile{
		Version: 1,
		Stats: map[string]Stats{
			"B7K3M2QA": {VisitCount: 89, LastVisitAt: time.Date(2026, 5, 23, 17, 12, 33, 0, time.UTC)},
		},
	}

	if err := saveState(path, original); err != nil {
		t.Fatal(err)
	}

	loaded, err := loadState(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Stats["B7K3M2QA"].VisitCount != 89 {
		t.Errorf("VisitCount = %d; want 89", loaded.Stats["B7K3M2QA"].VisitCount)
	}
}
