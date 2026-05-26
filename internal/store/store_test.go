package store_test

import (
	"testing"
	"time"

	"github.com/drewvanstone/snackpage/internal/store"
)

func TestStore_AddListVisitDelete(t *testing.T) {
	dir := t.TempDir()
	s, err := store.New(dir)
	if err != nil {
		t.Fatal(err)
	}

	bm, err := s.Add(store.Bookmark{
		Title:   "Team Dashboard",
		URL:     "https://example.com/board",
		Tags:    []string{"work", "Work", "jira"},   // dup + case
		Aliases: []string{"team board", "Sprint Board"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if bm.ID == "" {
		t.Error("ID was not assigned")
	}
	if bm.CreatedAt.IsZero() {
		t.Error("CreatedAt was not set")
	}
	if got := bm.Tags; len(got) != 2 || got[0] != "jira" || got[1] != "work" {
		t.Errorf("Tags = %v; want [jira work] (lowercased, deduped, sorted)", got)
	}

	now := time.Now().UTC()
	if err := s.Visit(bm.ID, now); err != nil {
		t.Fatal(err)
	}

	bookmarks, stats := s.List()
	if len(bookmarks) != 1 {
		t.Fatalf("len bookmarks = %d", len(bookmarks))
	}
	if stats[bm.ID].VisitCount != 1 {
		t.Errorf("VisitCount = %d; want 1", stats[bm.ID].VisitCount)
	}

	if err := s.Delete(bm.ID); err != nil {
		t.Fatal(err)
	}
	bookmarks, stats = s.List()
	if len(bookmarks) != 0 {
		t.Errorf("expected empty list after delete")
	}
	if _, ok := stats[bm.ID]; ok {
		t.Errorf("expected stats pruned after delete")
	}
}

func TestStore_RejectsInvalid(t *testing.T) {
	dir := t.TempDir()
	s, _ := store.New(dir)

	cases := []struct {
		name string
		b    store.Bookmark
	}{
		{"empty title", store.Bookmark{URL: "https://example.com"}},
		{"empty url", store.Bookmark{Title: "x"}},
		{"unparseable url", store.Bookmark{Title: "x", URL: "::::"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := s.Add(tc.b); err == nil {
				t.Error("expected error, got nil")
			}
		})
	}
}

func TestStore_AutoPrependsHTTPS(t *testing.T) {
	dir := t.TempDir()
	s, _ := store.New(dir)

	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"bare host", "example.com", "https://example.com"},
		{"host with path", "example.com/foo/bar", "https://example.com/foo/bar"},
		{"already has https", "https://example.com", "https://example.com"},
		{"already has http", "http://example.com", "http://example.com"},
		{"trims whitespace then prepends", "  example.com  ", "https://example.com"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bm, err := s.Add(store.Bookmark{Title: "t", URL: tc.input})
			if err != nil {
				t.Fatalf("Add: %v", err)
			}
			if bm.URL != tc.want {
				t.Errorf("URL = %q; want %q", bm.URL, tc.want)
			}
		})
	}
}

func TestStore_Update(t *testing.T) {
	dir := t.TempDir()
	s, _ := store.New(dir)

	bm, _ := s.Add(store.Bookmark{Title: "old", URL: "https://example.com"})

	updated, err := s.Update(bm.ID, store.Bookmark{Title: "new", URL: "https://example.com/v2"})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Title != "new" || updated.URL != "https://example.com/v2" {
		t.Errorf("update mismatch: %+v", updated)
	}
	if updated.ID != bm.ID {
		t.Errorf("ID changed: %s -> %s", bm.ID, updated.ID)
	}
	if !updated.CreatedAt.Equal(bm.CreatedAt) {
		t.Errorf("CreatedAt changed")
	}
}

func TestStore_PersistsAcrossRestart(t *testing.T) {
	dir := t.TempDir()

	s1, _ := store.New(dir)
	bm, _ := s1.Add(store.Bookmark{Title: "x", URL: "https://example.com"})

	s2, err := store.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	bms, _ := s2.List()
	if len(bms) != 1 || bms[0].ID != bm.ID {
		t.Errorf("did not persist; got %+v", bms)
	}
}
