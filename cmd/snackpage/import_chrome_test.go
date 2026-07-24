package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
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

func TestRunImportChromeDryRunDoesNotCreateDataDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "missing")
	code := runImportChrome([]string{
		"--path", filepath.Join("testdata", "chrome-bookmarks-sample.json"),
		"--data-dir", dir,
		"--offline",
		"--dry-run",
	})
	if code != 0 {
		t.Fatalf("runImportChrome code = %d; want 0", code)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("dry-run created data directory or returned unexpected stat error: %v", err)
	}
}

func TestRunImportChromeUsesOneDaemonBatch(t *testing.T) {
	requests := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodPost || r.URL.Path != "/api/bookmarks/batch" {
			t.Errorf("request = %s %s; want POST /api/bookmarks/batch", r.Method, r.URL.Path)
		}
		var body struct {
			Bookmarks        []bookmarkPayload `json:"bookmarks"`
			SkipExistingURLs bool              `json:"skip_existing_urls"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if len(body.Bookmarks) != 5 || !body.SkipExistingURLs {
			t.Errorf("batch = %+v; want 5 bookmarks with skip_existing_urls", body)
		}
		created := make([]map[string]string, len(body.Bookmarks))
		for i := range created {
			created[i] = map[string]string{"id": "0000000" + string(rune('A'+i))}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		if err := json.NewEncoder(w).Encode(map[string]any{
			"created":          created,
			"skipped_existing": 0,
		}); err != nil {
			t.Errorf("encode response: %v", err)
		}
	}))
	defer ts.Close()

	dir := filepath.Join(t.TempDir(), "must-not-be-created")
	code := runImportChrome([]string{
		"--path", filepath.Join("testdata", "chrome-bookmarks-sample.json"),
		"--addr", strings.TrimPrefix(ts.URL, "http://"),
		"--data-dir", dir,
	})
	if code != 0 {
		t.Fatalf("runImportChrome code = %d; want 0", code)
	}
	if requests != 1 {
		t.Fatalf("requests = %d; want exactly one batch request", requests)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("successful API import touched direct data dir: %v", err)
	}
}
