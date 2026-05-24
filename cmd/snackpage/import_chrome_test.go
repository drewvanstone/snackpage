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

func TestListChromeProfiles(t *testing.T) {
	// Build a fake Chrome user data dir.
	dir := t.TempDir()

	// Profile 2 with a real-looking Bookmarks file (3 URLs across the three roots).
	p2 := filepath.Join(dir, "Profile 2")
	if err := os.Mkdir(p2, 0o755); err != nil {
		t.Fatal(err)
	}
	p2Bookmarks := []byte(`{
        "roots": {
            "bookmark_bar": {"type":"folder","name":"Bookmarks bar","children":[
                {"type":"url","name":"A","url":"https://a"},
                {"type":"url","name":"B","url":"https://b"}
            ]},
            "other": {"type":"folder","name":"Other","children":[
                {"type":"url","name":"C","url":"https://c"}
            ]},
            "synced": {"type":"folder","name":"Mobile","children":[]}
        }
    }`)
	if err := os.WriteFile(filepath.Join(p2, "Bookmarks"), p2Bookmarks, 0o644); err != nil {
		t.Fatal(err)
	}

	// Profile 3 — directory exists but no Bookmarks file (should be skipped).
	if err := os.Mkdir(filepath.Join(dir, "Profile 3"), 0o755); err != nil {
		t.Fatal(err)
	}

	// A non-profile directory that should be filtered out.
	if err := os.Mkdir(filepath.Join(dir, "GraphiteDawnCache"), 0o755); err != nil {
		t.Fatal(err)
	}

	// Local State with metadata for Profile 2.
	localState := []byte(`{"profile":{"info_cache":{"Profile 2":{"name":"work","user_name":"d@example.com","gaia_name":"Drew"}}}}`)
	if err := os.WriteFile(filepath.Join(dir, "Local State"), localState, 0o644); err != nil {
		t.Fatal(err)
	}

	profiles, err := listChromeProfiles(dir)
	if err != nil {
		t.Fatal(err)
	}

	if len(profiles) != 1 {
		t.Fatalf("got %d profiles; want 1 (Profile 2 only)", len(profiles))
	}
	p := profiles[0]
	if p.Dir != "Profile 2" {
		t.Errorf("Dir = %q; want %q", p.Dir, "Profile 2")
	}
	if p.BookmarkCount != 3 {
		t.Errorf("BookmarkCount = %d; want 3", p.BookmarkCount)
	}
	if p.UserName != "d@example.com" || p.GaiaName != "Drew" {
		t.Errorf("metadata not populated: %+v", p)
	}
}

func TestFormatProfileIdentity(t *testing.T) {
	cases := []struct {
		in   chromeProfileInfo
		want string
	}{
		{chromeProfileInfo{GaiaName: "Drew", UserName: "d@e.com"}, "Drew / d@e.com"},
		{chromeProfileInfo{Name: "work", UserName: "d@e.com"}, "work / d@e.com"},
		{chromeProfileInfo{UserName: "d@e.com"}, "d@e.com"},
		{chromeProfileInfo{}, "(unknown identity)"},
	}
	for _, tc := range cases {
		if got := formatProfileIdentity(tc.in); got != tc.want {
			t.Errorf("for %+v: got %q; want %q", tc.in, got, tc.want)
		}
	}
}
