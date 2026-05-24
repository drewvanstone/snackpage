package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func loadSample(t *testing.T) *chromeFile {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "chrome-bookmarks-sample.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cf chromeFile
	if err := json.Unmarshal(data, &cf); err != nil {
		t.Fatal(err)
	}
	return &cf
}

func TestCollectCandidates_AllRoots(t *testing.T) {
	cf := loadSample(t)
	cands, err := collectCandidates(cf, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(cands) != 5 {
		t.Fatalf("got %d candidates; want 5", len(cands))
	}

	want := map[string]string{
		"Google":         "Bookmarks bar",
		"GitHub":         "Dev",
		"Stack Overflow": "Dev",
		"pkg.go.dev":     "Go",
		"Wikipedia":      "Other bookmarks",
	}
	got := map[string]string{}
	for _, c := range cands {
		got[c.Title] = c.Parent
	}
	for title, parent := range want {
		if got[title] != parent {
			t.Errorf("title %q: parent = %q; want %q", title, got[title], parent)
		}
	}
}

func TestCollectCandidates_FolderFilter(t *testing.T) {
	cf := loadSample(t)
	cands, err := collectCandidates(cf, "Bookmarks bar/Dev")
	if err != nil {
		t.Fatal(err)
	}
	if len(cands) != 3 {
		t.Fatalf("got %d candidates; want 3 (GitHub, Stack Overflow, pkg.go.dev)", len(cands))
	}
}

func TestCollectCandidates_NestedFolder(t *testing.T) {
	cf := loadSample(t)
	cands, err := collectCandidates(cf, "Bookmarks bar/Dev/Go")
	if err != nil {
		t.Fatal(err)
	}
	if len(cands) != 1 || cands[0].Title != "pkg.go.dev" {
		t.Errorf("got %+v; want [pkg.go.dev]", cands)
	}
}

func TestCollectCandidates_UnknownFolder(t *testing.T) {
	cf := loadSample(t)
	_, err := collectCandidates(cf, "Bookmarks bar/Nonexistent")
	if err == nil {
		t.Error("expected error for unknown folder")
	}
}

func TestCollectCandidates_UnknownRoot(t *testing.T) {
	cf := loadSample(t)
	_, err := collectCandidates(cf, "InvalidRoot")
	if err == nil {
		t.Error("expected error for unknown root")
	}
}

func TestCollectCandidates_FolderCaseInsensitive(t *testing.T) {
	cf := loadSample(t)
	cands, err := collectCandidates(cf, "bookmarks bar/dev")
	if err != nil {
		t.Fatal(err)
	}
	if len(cands) != 3 {
		t.Errorf("case-insensitive folder navigation failed: got %d", len(cands))
	}
}
