package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadBookmarks_MissingFile(t *testing.T) {
	dir := t.TempDir()
	got, err := loadBookmarks(filepath.Join(dir, "bookmarks.json"))
	if err != nil {
		t.Fatal(err)
	}
	if got.Version != 1 {
		t.Errorf("Version = %d; want 1", got.Version)
	}
	if len(got.Bookmarks) != 0 {
		t.Errorf("len Bookmarks = %d; want 0", len(got.Bookmarks))
	}
}

func TestSaveAndLoadBookmarks_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bookmarks.json")

	original := BookmarksFile{
		Version: 1,
		Bookmarks: []Bookmark{{
			ID:        "B7K3M2QA",
			Title:     "Team Dashboard",
			URL:       "https://example.com",
			Tags:      []string{"work"},
			Aliases:   []string{"team board"},
			CreatedAt: time.Date(2026, 5, 23, 12, 0, 0, 0, time.UTC),
		}},
	}

	if err := saveBookmarks(path, &original); err != nil {
		t.Fatal(err)
	}

	loaded, err := loadBookmarks(path)
	if err != nil {
		t.Fatal(err)
	}
	if !equalBookmarksFile(loaded, &original) {
		raw, _ := os.ReadFile(path)
		t.Errorf("round trip mismatch.\nfile:\n%s", raw)
	}
}

func TestLoadBookmarks_BadJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bookmarks.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadBookmarks(path); err == nil {
		t.Error("expected error on malformed JSON")
	}
}

// helper for round-trip comparison via JSON (handles nil vs empty slice etc.)
func equalBookmarksFile(a, b *BookmarksFile) bool {
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	return string(ja) == string(jb)
}
