# snackpage v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a single Go binary that runs `snackpage serve` on `127.0.0.1:8765`, exposes a keyboard-driven, snacks.nvim-inspired bookmark picker as the daily-driver new-tab page.

**Architecture:** stdlib-only Go HTTP server with all assets baked in via `embed.FS`; JSON-backed bookmark + state files at `$XDG_DATA_HOME/snackpage/`; vanilla-JS frontend with `fzf-for-js` for fuzzy ranking. See `docs/superpowers/specs/2026-05-23-snackpage-design.md` for full design rationale.

**Tech Stack:** Go 1.22+ (stdlib `net/http`, `log/slog`, `embed`, mux pattern routing), `fzf-for-js` (vendored), vanilla JS/HTML/CSS, Catppuccin Mocha palette, `make` for orchestration.

**Notes on layout deviation from spec:** The spec sketched `web/` at the project root. For embed-pattern reasons (Go's `//go:embed` cannot use `..` paths), we place assets under `internal/web/assets/` with a tiny `internal/web/web.go` exposing the `embed.FS`. This is a more idiomatic Go layout and the only meaningful deviation.

**Module path:** `github.com/drewvanstone/snackpage` (placeholder — rename at any time via a single `go mod edit -module` + import rewrite).

---

## Task 0: Bootstrap project — go.mod, Makefile, README skeleton, NOTICE

**Files:**
- Create: `go.mod`
- Create: `Makefile`
- Create: `README.md`
- Create: `NOTICE`
- Modify: `.gitignore`

- [ ] **Step 1: Initialize the Go module**

Run:
```bash
cd /Users/dflower/Code/personal/snackpage
go mod init github.com/drewvanstone/snackpage
```

Expected: creates `go.mod` with `module github.com/drewvanstone/snackpage` and `go 1.22` (or whatever's installed if newer).

- [ ] **Step 2: Pin the Go toolchain to 1.22+**

Open `go.mod` and confirm the `go` directive is `1.22` or higher. If lower, edit by hand:

```
module github.com/drewvanstone/snackpage

go 1.22
```

- [ ] **Step 3: Write the Makefile**

Create `Makefile`:

```makefile
.PHONY: all build test lint fmt run clean install

BIN := snackpage
PREFIX ?= $(HOME)/.local
GOFLAGS := -trimpath
LDFLAGS := -s -w -X main.version=$(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

all: build

build:
	go build $(GOFLAGS) -ldflags='$(LDFLAGS)' -o $(BIN) ./cmd/snackpage

test:
	go test ./... -race -cover

lint:
	go vet ./...
	@command -v golangci-lint >/dev/null && golangci-lint run ./... || echo "(golangci-lint not installed, skipping)"

fmt:
	gofmt -s -w .

run: build
	./$(BIN) serve

install: build
	install -d $(PREFIX)/bin
	install -m 0755 $(BIN) $(PREFIX)/bin/

clean:
	rm -f $(BIN)
	rm -f coverage.out coverage.html
```

- [ ] **Step 4: Write the NOTICE file**

Create `NOTICE`:

```
snackpage
Copyright 2026 Drew Flower

This product bundles fzf-for-js, which is available under the MIT license.
See https://github.com/ajitid/fzf-for-js for source.
The vendored copy lives at internal/web/assets/vendor/fzf.umd.min.js.
Version and sha256 are recorded inline at the top of that file.
```

- [ ] **Step 5: Write README skeleton**

Create `README.md`:

```markdown
# snackpage

A keyboard-driven bookmark picker, served from `localhost`, intended as your default browser new-tab page.

Status: **v1 in development** — see `docs/superpowers/plans/2026-05-23-snackpage-v1.md`.

## Quickstart (post-build)

```bash
make build
./snackpage serve
# open http://127.0.0.1:8765 in your browser
```

(Full README will be filled in by Task 21.)
```

- [ ] **Step 6: Extend .gitignore**

Append to `.gitignore` if missing:

```
# Go build / test
*.test
*.out
coverage.out
coverage.html

# Built binary
/snackpage
```

Run `cat .gitignore` and confirm the section above is present (it may already be, courtesy of the initial commit).

- [ ] **Step 7: Commit**

```bash
git add go.mod Makefile NOTICE README.md .gitignore
git commit -m "chore: bootstrap go module, Makefile, README skeleton"
```

---

## Task 1: `internal/xdg` — XDG path resolution

**Files:**
- Create: `internal/xdg/xdg.go`
- Test: `internal/xdg/xdg_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/xdg/xdg_test.go`:

```go
package xdg_test

import (
	"path/filepath"
	"testing"

	"github.com/drewvanstone/snackpage/internal/xdg"
)

func TestDataDir(t *testing.T) {
	t.Run("respects XDG_DATA_HOME", func(t *testing.T) {
		t.Setenv("XDG_DATA_HOME", "/tmp/xdg-test")
		got, err := xdg.DataDir("snackpage")
		if err != nil {
			t.Fatal(err)
		}
		want := "/tmp/xdg-test/snackpage"
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("falls back to ~/.local/share when env empty", func(t *testing.T) {
		t.Setenv("XDG_DATA_HOME", "")
		t.Setenv("HOME", "/tmp/home")
		got, err := xdg.DataDir("snackpage")
		if err != nil {
			t.Fatal(err)
		}
		want := filepath.Join("/tmp/home", ".local", "share", "snackpage")
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("errors when both env and HOME are empty", func(t *testing.T) {
		t.Setenv("XDG_DATA_HOME", "")
		t.Setenv("HOME", "")
		if _, err := xdg.DataDir("snackpage"); err == nil {
			t.Error("expected error, got nil")
		}
	})
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
go test ./internal/xdg/...
```
Expected: FAIL (`package github.com/drewvanstone/snackpage/internal/xdg is not in std`).

- [ ] **Step 3: Implement `internal/xdg/xdg.go`**

```go
// Package xdg resolves XDG Base Directory paths with sensible fallbacks.
package xdg

import (
	"errors"
	"os"
	"path/filepath"
)

// DataDir returns $XDG_DATA_HOME/<app>, falling back to ~/.local/share/<app>.
func DataDir(app string) (string, error) {
	if v := os.Getenv("XDG_DATA_HOME"); v != "" {
		return filepath.Join(v, app), nil
	}
	home := os.Getenv("HOME")
	if home == "" {
		return "", errors.New("xdg: neither XDG_DATA_HOME nor HOME is set")
	}
	return filepath.Join(home, ".local", "share", app), nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
go test ./internal/xdg/... -v
```
Expected: PASS for all three subtests.

- [ ] **Step 5: Commit**

```bash
git add internal/xdg/
git commit -m "feat(xdg): resolve XDG_DATA_HOME with fallback"
```

---

## Task 2: `internal/frecency` — score function

**Files:**
- Create: `internal/frecency/frecency.go`
- Test: `internal/frecency/frecency_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/frecency/frecency_test.go`:

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
go test ./internal/frecency/...
```
Expected: FAIL (package not found).

- [ ] **Step 3: Implement `internal/frecency/frecency.go`**

```go
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
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
go test ./internal/frecency/... -v
```
Expected: PASS for all seven subtests.

- [ ] **Step 5: Commit**

```bash
git add internal/frecency/
git commit -m "feat(frecency): score function with piecewise decay"
```

---

## Task 3: `internal/store` atomic file writes

**Files:**
- Create: `internal/store/atomic.go`
- Test: `internal/store/atomic_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/store/atomic_test.go`:

```go
package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAtomicWriteFile(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "data.json")

	if err := atomicWriteFile(target, []byte(`{"hello":"world"}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != `{"hello":"world"}` {
		t.Errorf("contents mismatch: %q", got)
	}

	info, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v; want 0o600", info.Mode().Perm())
	}

	// No leftover .tmp file
	tmp := target + ".tmp"
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Errorf("expected no leftover tmp file at %q", tmp)
	}
}

func TestAtomicWriteFile_Overwrite(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "data.json")

	if err := atomicWriteFile(target, []byte("v1"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := atomicWriteFile(target, []byte("v2"), 0o600); err != nil {
		t.Fatal(err)
	}

	got, _ := os.ReadFile(target)
	if string(got) != "v2" {
		t.Errorf("got %q; want %q", got, "v2")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
go test ./internal/store/...
```
Expected: FAIL (no such function `atomicWriteFile`).

- [ ] **Step 3: Implement `internal/store/atomic.go`**

```go
package store

import (
	"fmt"
	"os"
)

// atomicWriteFile writes data to path via a temp file in the same directory,
// fsyncs it, then renames over the target. The rename is atomic on the same
// filesystem. Leaves no leftover file on success; on failure, attempts to
// remove the temp file.
func atomicWriteFile(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return fmt.Errorf("create tmp: %w", err)
	}
	cleanup := func() { _ = os.Remove(tmp) }
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		cleanup()
		return fmt.Errorf("write tmp: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		cleanup()
		return fmt.Errorf("fsync tmp: %w", err)
	}
	if err := f.Close(); err != nil {
		cleanup()
		return fmt.Errorf("close tmp: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		cleanup()
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
go test ./internal/store/... -v
```
Expected: PASS for both subtests.

- [ ] **Step 5: Commit**

```bash
git add internal/store/
git commit -m "feat(store): atomic write-tmp-and-rename helper"
```

---

## Task 4: `internal/store` types + ID generator

**Files:**
- Create: `internal/store/types.go`
- Create: `internal/store/id.go`
- Test: `internal/store/id_test.go`

- [ ] **Step 1: Write the types file**

Create `internal/store/types.go`:

```go
package store

import "time"

// Bookmark is a single user-managed entry. Stable across edits.
type Bookmark struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	URL       string    `json:"url"`
	Tags      []string  `json:"tags"`
	Aliases   []string  `json:"aliases"`
	CreatedAt time.Time `json:"created_at"`
}

// Stats is the volatile state for a single bookmark.
type Stats struct {
	VisitCount  int       `json:"visit_count"`
	LastVisitAt time.Time `json:"last_visit_at,omitempty"`
}

// BookmarksFile is the on-disk shape of bookmarks.json.
type BookmarksFile struct {
	Version   int        `json:"version"`
	Bookmarks []Bookmark `json:"bookmarks"`
}

// StateFile is the on-disk shape of state.json.
type StateFile struct {
	Version int              `json:"version"`
	Stats   map[string]Stats `json:"stats"`
}
```

- [ ] **Step 2: Write the failing test for ID generator**

Create `internal/store/id_test.go`:

```go
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
```

- [ ] **Step 3: Run test to verify it fails**

Run:
```bash
go test ./internal/store/... -run TestNewID
```
Expected: FAIL (`undefined: NewID`).

- [ ] **Step 4: Implement `internal/store/id.go`**

```go
package store

import "crypto/rand"

const crockfordAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// NewID returns an 8-char Crockford base32 identifier from crypto/rand.
// Uniform: 256 mod 32 == 0, so byte % 32 has no bias.
func NewID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand never returns an error in normal operation;
		// if it does, fail loudly rather than silently emit a weak ID.
		panic("snackpage: crypto/rand.Read: " + err.Error())
	}
	for i := range b {
		b[i] = crockfordAlphabet[b[i]%32]
	}
	return string(b[:])
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
go test ./internal/store/... -v
```
Expected: PASS (all atomic + id tests).

- [ ] **Step 6: Commit**

```bash
git add internal/store/
git commit -m "feat(store): bookmark/stats types and Crockford base32 IDs"
```

---

## Task 5: `internal/store` bookmarks file load/save

**Files:**
- Create: `internal/store/bookmarks.go`
- Test: `internal/store/bookmarks_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/store/bookmarks_test.go`:

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
go test ./internal/store/... -run TestLoadBookmarks
```
Expected: FAIL (`undefined: loadBookmarks`).

- [ ] **Step 3: Implement `internal/store/bookmarks.go`**

```go
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

const bookmarksSchemaVersion = 1

// loadBookmarks reads bookmarks.json. Missing file returns an empty file
// at the current schema version; malformed JSON returns an error.
func loadBookmarks(path string) (*BookmarksFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &BookmarksFile{
				Version:   bookmarksSchemaVersion,
				Bookmarks: []Bookmark{},
			}, nil
		}
		return nil, fmt.Errorf("read bookmarks: %w", err)
	}
	var out BookmarksFile
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("parse bookmarks: %w", err)
	}
	if out.Bookmarks == nil {
		out.Bookmarks = []Bookmark{}
	}
	return &out, nil
}

// saveBookmarks marshals and atomically writes bookmarks.json.
func saveBookmarks(path string, f *BookmarksFile) error {
	if f.Bookmarks == nil {
		f.Bookmarks = []Bookmark{}
	}
	f.Version = bookmarksSchemaVersion
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return fmt.Errorf("encode bookmarks: %w", err)
	}
	return atomicWriteFile(path, data, 0o600)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
go test ./internal/store/... -v
```
Expected: PASS for all three bookmark-file tests plus prior ones.

- [ ] **Step 5: Commit**

```bash
git add internal/store/
git commit -m "feat(store): bookmarks.json load/save with version header"
```

---

## Task 6: `internal/store` state file load/save

**Files:**
- Create: `internal/store/state.go`
- Test: `internal/store/state_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/store/state_test.go`:

```go
package store

import (
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
go test ./internal/store/... -run TestLoadState
```
Expected: FAIL (`undefined: loadState`).

- [ ] **Step 3: Implement `internal/store/state.go`**

```go
package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

const stateSchemaVersion = 1

func loadState(path string) (*StateFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &StateFile{
				Version: stateSchemaVersion,
				Stats:   map[string]Stats{},
			}, nil
		}
		return nil, fmt.Errorf("read state: %w", err)
	}
	var out StateFile
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("parse state: %w", err)
	}
	if out.Stats == nil {
		out.Stats = map[string]Stats{}
	}
	return &out, nil
}

func saveState(path string, f *StateFile) error {
	if f.Stats == nil {
		f.Stats = map[string]Stats{}
	}
	f.Version = stateSchemaVersion
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return fmt.Errorf("encode state: %w", err)
	}
	return atomicWriteFile(path, data, 0o600)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
go test ./internal/store/... -v
```
Expected: PASS for all state tests + prior ones.

- [ ] **Step 5: Commit**

```bash
git add internal/store/
git commit -m "feat(store): state.json load/save with version header"
```

---

## Task 7: `internal/store` Store facade

**Files:**
- Create: `internal/store/store.go`
- Test: `internal/store/store_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/store/store_test.go`:

```go
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
		{"missing scheme", store.Bookmark{Title: "x", URL: "example.com"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := s.Add(tc.b); err == nil {
				t.Error("expected error, got nil")
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
go test ./internal/store/... -run TestStore
```
Expected: FAIL (`undefined: store.New`).

- [ ] **Step 3: Implement `internal/store/store.go`**

```go
package store

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Store is the in-memory facade over bookmarks.json and state.json.
type Store struct {
	dir           string
	bookmarksPath string
	statePath     string

	mu        sync.RWMutex
	bookmarks *BookmarksFile
	state     *StateFile
}

// New loads (or initializes) the store at dir. Creates the directory 0700
// if missing.
func New(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("mkdir data dir: %w", err)
	}
	s := &Store{
		dir:           dir,
		bookmarksPath: filepath.Join(dir, "bookmarks.json"),
		statePath:     filepath.Join(dir, "state.json"),
	}
	b, err := loadBookmarks(s.bookmarksPath)
	if err != nil {
		return nil, err
	}
	st, err := loadState(s.statePath)
	if err != nil {
		return nil, err
	}
	s.bookmarks = b
	s.state = st
	return s, nil
}

// List returns a snapshot of bookmarks and stats. Safe for concurrent use.
func (s *Store) List() ([]Bookmark, map[string]Stats) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	bms := make([]Bookmark, len(s.bookmarks.Bookmarks))
	copy(bms, s.bookmarks.Bookmarks)
	stats := make(map[string]Stats, len(s.state.Stats))
	for k, v := range s.state.Stats {
		stats[k] = v
	}
	return bms, stats
}

// Add validates, normalizes, assigns an ID and CreatedAt, persists, and
// returns the stored bookmark.
func (s *Store) Add(b Bookmark) (Bookmark, error) {
	if err := validateBookmark(&b); err != nil {
		return Bookmark{}, err
	}
	b.ID = NewID()
	b.CreatedAt = time.Now().UTC()

	s.mu.Lock()
	defer s.mu.Unlock()
	s.bookmarks.Bookmarks = append(s.bookmarks.Bookmarks, b)
	if err := saveBookmarks(s.bookmarksPath, s.bookmarks); err != nil {
		// roll back in-memory append
		s.bookmarks.Bookmarks = s.bookmarks.Bookmarks[:len(s.bookmarks.Bookmarks)-1]
		return Bookmark{}, err
	}
	return b, nil
}

// Update replaces fields of an existing bookmark by id. Preserves ID and CreatedAt.
func (s *Store) Update(id string, in Bookmark) (Bookmark, error) {
	if err := validateBookmark(&in); err != nil {
		return Bookmark{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, b := range s.bookmarks.Bookmarks {
		if b.ID == id {
			in.ID = b.ID
			in.CreatedAt = b.CreatedAt
			s.bookmarks.Bookmarks[i] = in
			if err := saveBookmarks(s.bookmarksPath, s.bookmarks); err != nil {
				s.bookmarks.Bookmarks[i] = b // roll back
				return Bookmark{}, err
			}
			return in, nil
		}
	}
	return Bookmark{}, errors.New("bookmark not found")
}

// Delete removes a bookmark and prunes its stats.
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, b := range s.bookmarks.Bookmarks {
		if b.ID == id {
			s.bookmarks.Bookmarks = append(s.bookmarks.Bookmarks[:i], s.bookmarks.Bookmarks[i+1:]...)
			delete(s.state.Stats, id)
			if err := saveBookmarks(s.bookmarksPath, s.bookmarks); err != nil {
				return err
			}
			return saveState(s.statePath, s.state)
		}
	}
	return errors.New("bookmark not found")
}

// Visit increments the visit count and updates last_visit_at for id.
// Returns an error if the bookmark does not exist.
func (s *Store) Visit(id string, when time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	found := false
	for _, b := range s.bookmarks.Bookmarks {
		if b.ID == id {
			found = true
			break
		}
	}
	if !found {
		return errors.New("bookmark not found")
	}
	cur := s.state.Stats[id]
	cur.VisitCount++
	cur.LastVisitAt = when.UTC()
	s.state.Stats[id] = cur
	return saveState(s.statePath, s.state)
}

func validateBookmark(b *Bookmark) error {
	b.Title = strings.TrimSpace(b.Title)
	b.URL = strings.TrimSpace(b.URL)
	if b.Title == "" {
		return errors.New("title is required")
	}
	if b.URL == "" {
		return errors.New("url is required")
	}
	u, err := url.Parse(b.URL)
	if err != nil {
		return fmt.Errorf("invalid url: %w", err)
	}
	if u.Scheme == "" || u.Host == "" {
		return errors.New("url must include scheme and host")
	}
	b.Tags = normalizeTags(b.Tags)
	b.Aliases = normalizeAliases(b.Aliases)
	return nil
}

// normalizeTags trims, lowercases, dedupes and sorts tags. Drops empty strings.
func normalizeTags(in []string) []string {
	if in == nil {
		return []string{}
	}
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, t := range in {
		t = strings.ToLower(strings.TrimSpace(t))
		if t == "" {
			continue
		}
		if _, ok := seen[t]; ok {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

// normalizeAliases trims, dedupes (preserving case for display) but does not lowercase.
func normalizeAliases(in []string) []string {
	if in == nil {
		return []string{}
	}
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, a := range in {
		a = strings.TrimSpace(a)
		if a == "" {
			continue
		}
		key := strings.ToLower(a)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, a)
	}
	return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
go test ./internal/store/... -v
```
Expected: PASS for all four `TestStore_*` plus prior ones.

- [ ] **Step 5: Commit**

```bash
git add internal/store/
git commit -m "feat(store): Store facade with Add/Update/Delete/Visit"
```

---

## Task 8: `internal/web` — embed FS skeleton

**Files:**
- Create: `internal/web/web.go`
- Create: `internal/web/assets/index.html` (placeholder)
- Create: `internal/web/assets/style.css` (empty)
- Create: `internal/web/assets/app.js` (empty)
- Test: `internal/web/web_test.go`

- [ ] **Step 1: Create placeholder asset files**

Create `internal/web/assets/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>snackpage</title>
  <link rel="stylesheet" href="/static/style.css">
</head>
<body>
  <p>snackpage placeholder — Task 14 will fill this in</p>
  <script src="/static/app.js"></script>
</body>
</html>
```

Create `internal/web/assets/style.css` and `internal/web/assets/app.js` as empty files:

```bash
mkdir -p internal/web/assets
touch internal/web/assets/style.css internal/web/assets/app.js
```

- [ ] **Step 2: Write the failing test**

Create `internal/web/web_test.go`:

```go
package web_test

import (
	"io"
	"testing"

	"github.com/drewvanstone/snackpage/internal/web"
)

func TestFS_ContainsIndex(t *testing.T) {
	f, err := web.FS.Open("assets/index.html")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	body, _ := io.ReadAll(f)
	if len(body) == 0 {
		t.Error("index.html is empty")
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run:
```bash
go test ./internal/web/...
```
Expected: FAIL (`undefined: web.FS`).

- [ ] **Step 4: Implement `internal/web/web.go`**

```go
// Package web exposes the embedded frontend assets.
package web

import "embed"

//go:embed assets
var FS embed.FS
```

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
go test ./internal/web/... -v
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/web/
git commit -m "feat(web): embed asset FS with placeholder index"
```

---

## Task 9: `internal/server` scaffold, middleware, healthz

**Files:**
- Create: `internal/server/server.go`
- Create: `internal/server/middleware.go`
- Test: `internal/server/server_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/server/server_test.go`:

```go
package server_test

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/drewvanstone/snackpage/internal/server"
	"github.com/drewvanstone/snackpage/internal/store"
)

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	st, err := store.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := server.New(st, logger).Handler()
	return httptest.NewServer(h)
}

func TestHealthz(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d; want 200", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if strings.TrimSpace(string(body)) != "ok" {
		t.Errorf("body = %q; want %q", body, "ok")
	}
}

func TestRoot_ServesIndex(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d; want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q; want text/html", ct)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "snackpage") {
		t.Errorf("body missing 'snackpage'; got: %s", body)
	}
}

func TestStaticAssets(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	for _, path := range []string{"/static/style.css", "/static/app.js"} {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("%s: status = %d; want 200", path, resp.StatusCode)
		}
	}
}

func TestUnknownRoute(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()
	resp, _ := http.Get(ts.URL + "/nope")
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d; want 404", resp.StatusCode)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
go test ./internal/server/...
```
Expected: FAIL (`undefined: server.New`).

- [ ] **Step 3: Implement `internal/server/middleware.go`**

```go
package server

import (
	"log/slog"
	"net/http"
	"time"
)

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// logRequests is a tiny access-log middleware.
func logRequests(l *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		l.Info("http",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"dur_ms", time.Since(start).Milliseconds(),
		)
	})
}

// recoverPanics turns a handler panic into a 500.
func recoverPanics(l *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				l.Error("panic", "panic", rec, "path", r.URL.Path)
				http.Error(w, "internal server error", http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}
```

- [ ] **Step 4: Implement `internal/server/server.go`**

```go
// Package server hosts the snackpage HTTP handlers.
package server

import (
	"io/fs"
	"log/slog"
	"net/http"

	"github.com/drewvanstone/snackpage/internal/store"
	"github.com/drewvanstone/snackpage/internal/web"
)

// Server bundles handler dependencies.
type Server struct {
	store  *store.Store
	logger *slog.Logger
	assets fs.FS
}

// New constructs a Server. The handler is built lazily via Handler().
func New(s *store.Store, l *slog.Logger) *Server {
	sub, err := fs.Sub(web.FS, "assets")
	if err != nil {
		panic("snackpage/server: cannot sub embedded assets: " + err.Error())
	}
	return &Server{store: s, logger: l, assets: sub}
}

// Handler returns the routed http.Handler (with middleware applied).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.handleIndex)
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.FS(s.assets))))
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	return recoverPanics(s.logger, logRequests(s.logger, mux))
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte("ok"))
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	f, err := s.assets.Open("index.html")
	if err != nil {
		http.Error(w, "index missing", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	http.ServeContent(w, r, "index.html", time.Time{}, f.(io.ReadSeeker))
}
```

Add imports as needed (`io`, `time`).

Wait — `http.ServeContent` needs a `ReadSeeker`, but `fs.File` from an embed.FS *does* satisfy it. Verify with the test. If type assertion fails, switch to:

```go
data, _ := fs.ReadFile(s.assets, "index.html")
_, _ = w.Write(data)
```

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
go test ./internal/server/... -v
```
Expected: PASS for `TestHealthz`, `TestRoot_ServesIndex`, `TestStaticAssets`, `TestUnknownRoute`.

If `TestRoot_ServesIndex` fails because `ServeContent` panics on a non-seekable file, swap `handleIndex` to read-and-write as noted above.

- [ ] **Step 6: Commit**

```bash
git add internal/server/
git commit -m "feat(server): scaffold mux + healthz + index + middleware"
```

---

## Task 10: `internal/server` bookmarks GET handler

**Files:**
- Create: `internal/server/bookmarks.go`
- Modify: `internal/server/server.go` (register routes)
- Modify: `internal/server/server_test.go` (add GET /api/bookmarks tests)

- [ ] **Step 1: Append failing tests to `internal/server/server_test.go`**

Append:

```go
func TestGetBookmarks_Empty(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/bookmarks")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d; want 200", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"bookmarks":[]`) {
		t.Errorf("body = %s", body)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
go test ./internal/server/... -run TestGetBookmarks_Empty
```
Expected: FAIL (404 since route is unregistered).

- [ ] **Step 3: Implement `internal/server/bookmarks.go`**

```go
package server

import (
	"encoding/json"
	"net/http"

	"github.com/drewvanstone/snackpage/internal/store"
)

// bookmarkView is the wire shape: bookmark fields plus stats inline.
type bookmarkView struct {
	store.Bookmark
	VisitCount  int    `json:"visit_count"`
	LastVisitAt string `json:"last_visit_at,omitempty"`
}

func (s *Server) handleListBookmarks(w http.ResponseWriter, _ *http.Request) {
	bms, stats := s.store.List()
	views := make([]bookmarkView, 0, len(bms))
	for _, b := range bms {
		st := stats[b.ID]
		v := bookmarkView{Bookmark: b, VisitCount: st.VisitCount}
		if !st.LastVisitAt.IsZero() {
			v.LastVisitAt = st.LastVisitAt.UTC().Format("2006-01-02T15:04:05Z")
		}
		views = append(views, v)
	}
	writeJSON(w, http.StatusOK, map[string]any{"bookmarks": views})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
```

- [ ] **Step 4: Register the route in `internal/server/server.go`**

Inside `Handler()`, after the existing `mux.HandleFunc("GET /healthz", ...)` line, add:

```go
mux.HandleFunc("GET /api/bookmarks", s.handleListBookmarks)
```

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
go test ./internal/server/... -v
```
Expected: PASS (including new `TestGetBookmarks_Empty`).

- [ ] **Step 6: Commit**

```bash
git add internal/server/
git commit -m "feat(server): GET /api/bookmarks returns stats-merged list"
```

---

## Task 11: `internal/server` bookmarks POST/PUT/DELETE

**Files:**
- Modify: `internal/server/bookmarks.go`
- Modify: `internal/server/server.go` (register routes)
- Modify: `internal/server/server_test.go` (CRUD tests)

- [ ] **Step 1: Append failing tests**

Append to `internal/server/server_test.go`:

```go
func postJSON(t *testing.T, url, body string) (*http.Response, []byte) {
	t.Helper()
	resp, err := http.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp, data
}

func TestPostBookmark_Creates(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	resp, body := postJSON(t, ts.URL+"/api/bookmarks", `{
		"title":"Team Dashboard",
		"url":"https://example.com",
		"tags":["work"],
		"aliases":["team board"]
	}`)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d; body = %s", resp.StatusCode, body)
	}
	if !strings.Contains(string(body), `"id":"`) {
		t.Errorf("response missing id: %s", body)
	}
}

func TestPostBookmark_RejectsBadURL(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()
	resp, _ := postJSON(t, ts.URL+"/api/bookmarks", `{"title":"x","url":"::::"}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d; want 400", resp.StatusCode)
	}
}

func TestPutBookmark_Updates(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()
	resp, body := postJSON(t, ts.URL+"/api/bookmarks", `{"title":"a","url":"https://example.com"}`)
	var created struct{ ID string `json:"id"` }
	_ = json.Unmarshal(body, &created)

	req, _ := http.NewRequest("PUT", ts.URL+"/api/bookmarks/"+created.ID,
		strings.NewReader(`{"title":"b","url":"https://example.com/v2"}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d", resp.StatusCode)
	}
}

func TestDeleteBookmark(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()
	_, body := postJSON(t, ts.URL+"/api/bookmarks", `{"title":"a","url":"https://example.com"}`)
	var created struct{ ID string `json:"id"` }
	_ = json.Unmarshal(body, &created)

	req, _ := http.NewRequest("DELETE", ts.URL+"/api/bookmarks/"+created.ID, nil)
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("status = %d; want 204", resp.StatusCode)
	}
}

func TestDeleteBookmark_NotFound(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()
	req, _ := http.NewRequest("DELETE", ts.URL+"/api/bookmarks/00000000", nil)
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d; want 404", resp.StatusCode)
	}
}
```

Also add `"encoding/json"` to the test file imports.

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
go test ./internal/server/... -run "TestPostBookmark|TestPutBookmark|TestDeleteBookmark"
```
Expected: FAIL (handlers not registered).

- [ ] **Step 3: Add CRUD handlers to `internal/server/bookmarks.go`**

Append:

```go
type bookmarkInput struct {
	Title   string   `json:"title"`
	URL     string   `json:"url"`
	Tags    []string `json:"tags"`
	Aliases []string `json:"aliases"`
}

func (s *Server) handleCreateBookmark(w http.ResponseWriter, r *http.Request) {
	var in bookmarkInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	created, err := s.store.Add(store.Bookmark{
		Title:   in.Title,
		URL:     in.URL,
		Tags:    in.Tags,
		Aliases: in.Aliases,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) handleUpdateBookmark(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var in bookmarkInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	updated, err := s.store.Update(id, store.Bookmark{
		Title:   in.Title,
		URL:     in.URL,
		Tags:    in.Tags,
		Aliases: in.Aliases,
	})
	if err != nil {
		if err.Error() == "bookmark not found" {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handleDeleteBookmark(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.store.Delete(id); err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
```

- [ ] **Step 4: Register routes in `internal/server/server.go`**

Add to `Handler()`:

```go
mux.HandleFunc("POST /api/bookmarks", s.handleCreateBookmark)
mux.HandleFunc("PUT /api/bookmarks/{id}", s.handleUpdateBookmark)
mux.HandleFunc("DELETE /api/bookmarks/{id}", s.handleDeleteBookmark)
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
go test ./internal/server/... -v
```
Expected: PASS for all CRUD tests.

- [ ] **Step 6: Commit**

```bash
git add internal/server/
git commit -m "feat(server): POST/PUT/DELETE /api/bookmarks handlers"
```

---

## Task 12: `internal/server` redirect handler `/go/:id`

**Files:**
- Create: `internal/server/redirect.go`
- Modify: `internal/server/server.go` (register route)
- Modify: `internal/server/server_test.go` (redirect test)

- [ ] **Step 1: Append failing test**

Append to `internal/server/server_test.go`:

```go
func TestRedirect_BumpsStatsAndRedirects(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	_, body := postJSON(t, ts.URL+"/api/bookmarks", `{"title":"X","url":"https://example.com/x"}`)
	var created struct{ ID string `json:"id"` }
	_ = json.Unmarshal(body, &created)

	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Get(ts.URL + "/go/" + created.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Errorf("status = %d; want 302", resp.StatusCode)
	}
	if loc := resp.Header.Get("Location"); loc != "https://example.com/x" {
		t.Errorf("Location = %q; want %q", loc, "https://example.com/x")
	}

	// Verify GET /api/bookmarks now shows visit_count: 1
	listResp, _ := http.Get(ts.URL + "/api/bookmarks")
	defer listResp.Body.Close()
	listBody, _ := io.ReadAll(listResp.Body)
	if !strings.Contains(string(listBody), `"visit_count":1`) {
		t.Errorf("expected visit_count=1; got %s", listBody)
	}
}

func TestRedirect_NotFound(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()
	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, _ := client.Get(ts.URL + "/go/00000000")
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d; want 404", resp.StatusCode)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
go test ./internal/server/... -run "TestRedirect"
```
Expected: FAIL.

- [ ] **Step 3: Implement `internal/server/redirect.go`**

```go
package server

import (
	"net/http"
	"time"
)

func (s *Server) handleRedirect(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	// Find bookmark
	bms, _ := s.store.List()
	var url string
	for _, b := range bms {
		if b.ID == id {
			url = b.URL
			break
		}
	}
	if url == "" {
		writeError(w, http.StatusNotFound, "bookmark not found")
		return
	}

	// Bump stats best-effort — never block the redirect on a disk error.
	if err := s.store.Visit(id, time.Now().UTC()); err != nil {
		s.logger.Warn("visit_record_failed", "id", id, "err", err)
	}
	http.Redirect(w, r, url, http.StatusFound)
}
```

- [ ] **Step 4: Register route in `internal/server/server.go`**

Add to `Handler()`:

```go
mux.HandleFunc("GET /go/{id}", s.handleRedirect)
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
```bash
go test ./internal/server/... -v
```
Expected: PASS for both new tests.

- [ ] **Step 6: Commit**

```bash
git add internal/server/
git commit -m "feat(server): /go/:id redirect handler with stats bump"
```

---

## Task 13: `cmd/snackpage` main + `serve` subcommand + `version`

**Files:**
- Create: `cmd/snackpage/main.go`

- [ ] **Step 1: Implement `cmd/snackpage/main.go`**

```go
// Command snackpage serves a keyboard-driven bookmark picker on localhost.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/drewvanstone/snackpage/internal/server"
	"github.com/drewvanstone/snackpage/internal/store"
	"github.com/drewvanstone/snackpage/internal/xdg"
)

// Injected at build time via -ldflags.
var version = "dev"

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(2)
	}
	sub, args := os.Args[1], os.Args[2:]
	switch sub {
	case "serve":
		os.Exit(runServe(args))
	case "version", "--version", "-v":
		fmt.Println("snackpage", version)
	case "help", "--help", "-h":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "snackpage: unknown subcommand %q\n", sub)
		printUsage()
		os.Exit(2)
	}
}

func printUsage() {
	fmt.Fprintln(os.Stderr, `Usage:
  snackpage serve [--addr 127.0.0.1:8765] [--data-dir PATH] [--log-level info]
  snackpage version
  snackpage help`)
}

func runServe(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", "127.0.0.1:8765", "address to listen on (loopback recommended)")
	dataDir := fs.String("data-dir", "", "override XDG data dir")
	logLevel := fs.String("log-level", "info", "debug|info|warn|error")
	_ = fs.Parse(args)

	level, err := parseLevel(*logLevel)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	dir := *dataDir
	if dir == "" {
		dir, err = xdg.DataDir("snackpage")
		if err != nil {
			logger.Error("data_dir_resolve_failed", "err", err)
			return 1
		}
	}
	st, err := store.New(dir)
	if err != nil {
		logger.Error("store_open_failed", "err", err)
		return 1
	}

	srv := &http.Server{
		Addr:              *addr,
		Handler:           server.New(st, logger).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		logger.Info("listening", "addr", *addr, "data_dir", dir)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server_failed", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	logger.Info("shutting_down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown_failed", "err", err)
		return 1
	}
	return 0
}

func parseLevel(s string) (slog.Leveler, error) {
	switch s {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return nil, fmt.Errorf("unknown log level %q", s)
	}
}
```

- [ ] **Step 2: Build and smoke-test**

Run:
```bash
make build
./snackpage version
```
Expected: prints `snackpage dev` (or git-described version).

```bash
./snackpage serve --addr 127.0.0.1:18765 --data-dir /tmp/snackpage-smoke &
sleep 0.3
curl -s http://127.0.0.1:18765/healthz
echo
curl -s http://127.0.0.1:18765/api/bookmarks
echo
kill %1
```
Expected: `ok` and `{"bookmarks":[]}`.

- [ ] **Step 3: Run the full test suite once**

Run:
```bash
make test
```
Expected: PASS across all packages, with race detector + coverage.

- [ ] **Step 4: Commit**

```bash
git add cmd/ Makefile
git commit -m "feat(cmd): main with serve and version subcommands"
```

---

## Task 14: Frontend `index.html` + `style.css` (Catppuccin shell)

**Files:**
- Modify: `internal/web/assets/index.html`
- Modify: `internal/web/assets/style.css`

**Note on testing approach:** Frontend tasks (14–20) are validated manually in the browser. Playwright is a v1.1 item. After each task, run `make run`, hit `http://127.0.0.1:8765`, and confirm the listed acceptance criteria.

- [ ] **Step 1: Rewrite `internal/web/assets/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>snackpage</title>
  <link rel="stylesheet" href="/static/style.css">
</head>
<body>
  <main class="picker" id="picker">
    <div class="picker-title">snackpage</div>
    <div class="prompt">
      <span class="glyph">❯</span>
      <input id="q" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus>
    </div>
    <ul id="list" class="list" aria-live="polite"></ul>
    <div class="footer">
      <span id="count"></span>
      <span class="hints">↑↓ select · ⏎ open · ⌘N add · ⌘E edit · ⌘D delete · ⎋ clear</span>
    </div>
  </main>

  <div id="modal-root"></div>

  <script type="module" src="/static/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `internal/web/assets/style.css` with the Catppuccin Mocha palette**

```css
/* Catppuccin Mocha */
:root {
  --base:     #1e1e2e;
  --mantle:   #181825;
  --crust:    #11111b;
  --surface0: #313244;
  --surface1: #45475a;
  --surface2: #585b70;
  --overlay0: #6c7086;
  --overlay1: #7f849c;
  --overlay2: #9399b2;
  --subtext0: #a6adc8;
  --subtext1: #bac2de;
  --text:     #cdd6f4;
  --mauve:    #cba6f7;
  --pink:     #f5c2e7;
  --rosewater:#f5e0dc;
  --red:      #f38ba8;
  --peach:    #fab387;
  --yellow:   #f9e2af;
  --green:    #a6e3a1;
  --blue:     #89b4fa;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
  height: 100%;
  background: var(--base);
  color: var(--text);
  font-family: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace;
  font-size: 14px;
  line-height: 1.45;
}

body {
  display: flex;
  align-items: center;
  justify-content: center;
}

.picker {
  width: min(960px, 92vw);
  background: var(--base);
  border: 1px solid var(--surface1);
  border-radius: 10px;
  padding: 1rem 1.25rem;
  box-shadow: 0 10px 40px rgba(0,0,0,0.4);
}

.picker-title {
  color: var(--mauve);
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 0.65rem;
}

.prompt {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  background: var(--mantle);
  border: 1px solid var(--surface1);
  border-radius: 6px;
  padding: 0.5rem 0.7rem;
  margin-bottom: 0.8rem;
}
.prompt .glyph { color: var(--yellow); }
.prompt input {
  background: transparent;
  border: none;
  color: var(--text);
  font: inherit;
  outline: none;
  flex: 1;
  caret-color: var(--rosewater);
}

.list {
  list-style: none;
  max-height: 60vh;
  overflow-y: auto;
}
.row {
  display: grid;
  grid-template-columns: 0.5rem 1fr auto;
  gap: 0.75rem;
  align-items: center;
  padding: 0.45rem 0.55rem;
  border-radius: 5px;
  cursor: pointer;
}
.row[aria-selected="true"] {
  background: rgba(203, 166, 247, 0.16);
}
.row .marker { color: var(--mauve); font-weight: bold; opacity: 0; }
.row[aria-selected="true"] .marker { opacity: 1; }

.title { color: var(--text); font-weight: 600; }
.sub { color: var(--overlay1); font-size: 0.78rem; margin-top: 1px; }
.meta { color: var(--surface2); font-size: 0.78rem; text-align: right; }
.meta .count { display: block; color: var(--subtext0); font-size: 0.72rem; }

.row.deleting { background: rgba(243, 139, 168, 0.18); }
.row.deleting .title { color: var(--red); }

.footer {
  margin-top: 0.7rem;
  padding-top: 0.55rem;
  border-top: 1px solid var(--surface0);
  display: flex;
  justify-content: space-between;
  color: var(--overlay0);
  font-size: 0.72rem;
}

/* Modal */
.modal-overlay {
  position: fixed; inset: 0;
  background: rgba(17, 17, 27, 0.55);
  display: flex; align-items: center; justify-content: center;
  z-index: 10;
}
.modal {
  width: min(560px, 92vw);
  background: var(--mantle);
  border: 1px solid var(--surface1);
  border-radius: 10px;
  padding: 1.1rem 1.2rem 1rem;
  box-shadow: 0 14px 50px rgba(0,0,0,0.6);
}
.modal h2 {
  color: var(--rosewater);
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 0.9rem;
  display: flex;
  justify-content: space-between;
}
.modal h2 .esc { color: var(--overlay0); font-weight: normal; text-transform: none; letter-spacing: 0; font-size: 0.7rem; }
.field { margin-bottom: 0.7rem; }
.field label {
  display: block;
  color: var(--subtext0);
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 0.25rem;
}
.field input {
  width: 100%;
  background: var(--base);
  border: 1px solid var(--surface0);
  color: var(--text);
  font: inherit;
  padding: 0.45rem 0.55rem;
  border-radius: 5px;
  outline: none;
}
.field input:focus { border-color: var(--mauve); }
.field .hint { color: var(--overlay0); font-size: 0.66rem; margin-top: 0.2rem; }
.field .error { color: var(--red); font-size: 0.7rem; margin-top: 0.2rem; }

.modal-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 0.85rem;
  padding-top: 0.7rem;
  border-top: 1px solid var(--surface0);
  color: var(--overlay0);
  font-size: 0.7rem;
}
.modal-footer .actions { display: flex; gap: 0.5rem; }
.btn {
  background: transparent;
  border: 1px solid var(--surface1);
  color: var(--text);
  padding: 0.35rem 0.8rem;
  border-radius: 5px;
  font: inherit;
  cursor: pointer;
}
.btn-primary {
  background: var(--mauve);
  border-color: var(--mauve);
  color: var(--base);
  font-weight: 600;
}
```

- [ ] **Step 3: Smoke test**

Run `make run` and open `http://127.0.0.1:8765` in Chrome. Acceptance:

- Page is dark Catppuccin background, monospace.
- Title "snackpage" appears in mauve.
- Prompt with `❯` glyph and input field visible; cursor blinks in input on focus.
- List is empty, footer shows the hints text.

Stop with Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add internal/web/assets/
git commit -m "feat(web): Catppuccin Mocha shell + index skeleton"
```

---

## Task 15: Vendor `fzf-for-js`

**Files:**
- Create: `internal/web/assets/vendor/fzf.umd.min.js`

- [ ] **Step 1: Download the library**

Run:
```bash
mkdir -p internal/web/assets/vendor
curl -fsSL -o internal/web/assets/vendor/fzf.umd.min.js https://cdn.jsdelivr.net/npm/fzf@latest/dist/fzf.umd.min.js
```

If `fzf@latest` returns nothing (the npm package name changed), fall back to:

```bash
curl -fsSL -o internal/web/assets/vendor/fzf.umd.min.js \
  https://cdn.jsdelivr.net/npm/fzf-for-js@latest/dist/fzf.umd.min.js
```

Verify it loaded (should be ~30 KB):

```bash
ls -la internal/web/assets/vendor/fzf.umd.min.js
```

- [ ] **Step 2: Record version + sha256 in NOTICE**

Run:
```bash
shasum -a 256 internal/web/assets/vendor/fzf.umd.min.js
```

Append the result and the source URL to `NOTICE`:

```
fzf-for-js
  source:  https://cdn.jsdelivr.net/npm/fzf@latest/dist/fzf.umd.min.js
  sha256:  <output of shasum above>
  fetched: 2026-05-23
```

- [ ] **Step 3: Smoke test that it's served**

Run `make run` and:

```bash
curl -sI http://127.0.0.1:8765/static/vendor/fzf.umd.min.js | head -1
```
Expected: `HTTP/1.1 200 OK`.

- [ ] **Step 4: Commit**

```bash
git add internal/web/assets/vendor/ NOTICE
git commit -m "vendor: fzf-for-js for fuzzy ranking"
```

---

## Task 16: Frontend `app.js` — fetch + render + frecency sort

**Files:**
- Modify: `internal/web/assets/app.js`
- Modify: `internal/web/assets/index.html` (load fzf.umd.min.js before app.js)

- [ ] **Step 1: Add the vendor script tag to `internal/web/assets/index.html`**

Just before `<script type="module" src="/static/app.js"></script>`, insert:

```html
<script src="/static/vendor/fzf.umd.min.js"></script>
```

- [ ] **Step 2: Implement initial `internal/web/assets/app.js`**

```javascript
// snackpage frontend. Vanilla JS, no build step.
// Public surface: nothing — everything is module-scoped.

const state = {
  bookmarks: [],   // [{id,title,url,tags,aliases,visit_count,last_visit_at}]
  view: [],        // filtered + sorted subset rendered to DOM
  selected: 0,     // index into view
};

const $q = document.getElementById("q");
const $list = document.getElementById("list");
const $count = document.getElementById("count");

async function load() {
  const r = await fetch("/api/bookmarks");
  const j = await r.json();
  state.bookmarks = j.bookmarks || [];
  refresh();
}

function refresh() {
  const q = $q.value.trim();
  state.view = q === "" ? sortByFrecency(state.bookmarks) : state.bookmarks; // search added in Task 17
  if (state.selected >= state.view.length) state.selected = Math.max(0, state.view.length - 1);
  render();
}

function sortByFrecency(items) {
  const now = Date.now();
  const scored = items.map(b => ({ b, score: frecency(b, now), title: b.title.toLowerCase() }));
  scored.sort((a, z) => z.score - a.score || a.title.localeCompare(z.title));
  return scored.map(s => s.b);
}

function frecency(b, now) {
  const last = b.last_visit_at ? new Date(b.last_visit_at).getTime() : 0;
  const visits = b.visit_count || 0;
  let decay;
  if (!last) {
    decay = 0.1;
  } else {
    const days = Math.floor((now - last) / 86_400_000);
    if (days <= 1) decay = 1.0;
    else if (days <= 7) decay = 0.6;
    else if (days <= 30) decay = 0.3;
    else decay = 0.1;
  }
  return Math.max(visits, 1) * decay;
}

function relTime(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

function render() {
  $list.innerHTML = "";
  state.view.forEach((b, i) => {
    const li = document.createElement("li");
    li.className = "row";
    li.setAttribute("aria-selected", i === state.selected ? "true" : "false");
    li.dataset.id = b.id;
    li.innerHTML = `
      <span class="marker">▌</span>
      <div>
        <div class="title">${escapeHTML(b.title)}</div>
        <div class="sub">${escapeHTML(b.url)}${b.tags && b.tags.length ? "  ·  " + b.tags.map(escapeHTML).join(", ") : ""}</div>
      </div>
      <div class="meta">${relTime(b.last_visit_at)}<span class="count">${b.visit_count || 0} visits</span></div>
    `;
    $list.appendChild(li);
  });
  $count.textContent = `${state.view.length} / ${state.bookmarks.length}`;
}

$q.addEventListener("input", refresh);

load();
```

- [ ] **Step 3: Smoke test**

Run `make run` and seed two bookmarks via curl:

```bash
curl -sX POST -H 'content-type: application/json' http://127.0.0.1:8765/api/bookmarks \
  -d '{"title":"Kubernetes Docs","url":"https://kubernetes.io","tags":["k8s","docs"]}'
curl -sX POST -H 'content-type: application/json' http://127.0.0.1:8765/api/bookmarks \
  -d '{"title":"K9s GitHub","url":"https://github.com/derailed/k9s","tags":["k8s","tui"]}'
```

Reload the browser. Acceptance:

- Both rows render with title, URL · tags subline, and "never" / "0 visits" metadata.
- The first row in the list has the mauve marker `▌`.

Stop the server.

- [ ] **Step 4: Commit**

```bash
git add internal/web/assets/
git commit -m "feat(web): fetch, render, and frecency-sort bookmarks"
```

---

## Task 17: Frontend fuzzy search (fzf-for-js)

**Files:**
- Modify: `internal/web/assets/app.js`

- [ ] **Step 1: Replace the body of `refresh()` and add a fuzzy-ranking helper**

Locate the `refresh()` function in `app.js` and replace it (plus add a new function below it):

```javascript
function refresh() {
  const q = $q.value.trim();
  if (q === "") {
    state.view = sortByFrecency(state.bookmarks);
  } else {
    state.view = fuzzyRank(q, state.bookmarks);
  }
  if (state.selected >= state.view.length) state.selected = Math.max(0, state.view.length - 1);
  if (state.view.length > 0 && state.selected < 0) state.selected = 0;
  render();
}

// Weighted fzf ranking. Falls back to substring match if fzf failed to load.
function fuzzyRank(q, items) {
  const F = window.fzf;
  if (!F) {
    const ql = q.toLowerCase();
    return items.filter(b =>
      b.title.toLowerCase().includes(ql) ||
      b.url.toLowerCase().includes(ql) ||
      (b.tags || []).some(t => t.toLowerCase().includes(ql)) ||
      (b.aliases || []).some(a => a.toLowerCase().includes(ql))
    );
  }
  // fzf-for-js: build a Fzf finder per field, score, sum.
  const titleFinder = new F.Fzf(items, { selector: i => i.title });
  const urlFinder = new F.Fzf(items, { selector: i => i.url });
  const tagsFinder = new F.Fzf(items, { selector: i => (i.tags || []).join(" ") });
  const aliasFinder = new F.Fzf(items, { selector: i => (i.aliases || []).join(" ") });

  const scoreMap = new Map(); // id -> { score, item }
  function feed(finder, weight) {
    const entries = finder.find(q);
    for (const e of entries) {
      const cur = scoreMap.get(e.item.id) || { score: 0, item: e.item };
      cur.score += weight * e.score;
      scoreMap.set(e.item.id, cur);
    }
  }
  feed(titleFinder, 4);
  feed(aliasFinder, 3);
  feed(tagsFinder, 2);
  feed(urlFinder, 1);

  const now = Date.now();
  const ranked = [...scoreMap.values()].map(({ score, item }) => ({
    item,
    score: score + 0.001 * frecency(item, now),
  }));
  ranked.sort((a, z) => z.score - a.score);
  return ranked.map(r => r.item);
}
```

- [ ] **Step 2: Smoke test**

Run `make run`, seed three bookmarks (use the curls from Task 16 plus one more), then in the browser:

- Type `k` → both k8s entries appear, the more-recent-clicked one first (or alphabetical if both unvisited).
- Type `kub` → only Kubernetes Docs appears.
- Backspace to empty → full list returns.

Stop the server.

- [ ] **Step 3: Commit**

```bash
git add internal/web/assets/app.js
git commit -m "feat(web): weighted fzf-for-js fuzzy ranking across all fields"
```

---

## Task 18: Frontend keymap + open behavior

**Files:**
- Modify: `internal/web/assets/app.js`

- [ ] **Step 1: Append keymap logic to `app.js`**

Append (after the `$q.addEventListener("input", refresh);` line):

```javascript
function move(delta) {
  if (state.view.length === 0) return;
  state.selected = (state.selected + delta + state.view.length) % state.view.length;
  render();
  // Scroll selected into view
  const sel = $list.querySelector('[aria-selected="true"]');
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

function openSelected(newTab) {
  const b = state.view[state.selected];
  if (!b) return;
  const url = "/go/" + encodeURIComponent(b.id);
  if (newTab) window.open(url, "_blank");
  else window.location.href = url;
}

// Global key handler — runs at capture phase so we can override input behavior.
document.addEventListener("keydown", (e) => {
  // Modal handles its own keys; bail when one is open.
  if (document.querySelector(".modal-overlay")) return;

  const inInput = document.activeElement === $q;
  const empty = $q.value === "";

  // Navigation: arrows + Ctrl+N/P (always); j/k (only when input is empty)
  if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
    e.preventDefault(); move(1); return;
  }
  if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
    e.preventDefault(); move(-1); return;
  }
  if ((!inInput || empty) && (e.key === "j")) {
    if (inInput && empty) { e.preventDefault(); move(1); return; }
    if (!inInput) { e.preventDefault(); move(1); return; }
  }
  if ((!inInput || empty) && (e.key === "k")) {
    if (inInput && empty) { e.preventDefault(); move(-1); return; }
    if (!inInput) { e.preventDefault(); move(-1); return; }
  }

  if (e.key === "Enter") {
    if ((e.metaKey || e.ctrlKey)) { e.preventDefault(); openSelected(true); return; }
    e.preventDefault(); openSelected(false); return;
  }
  if (e.key === "Escape") {
    if ($q.value !== "") { $q.value = ""; refresh(); }
    else $q.blur();
    return;
  }
  if (e.key === "/" && !inInput) {
    e.preventDefault();
    $q.focus();
    return;
  }
});

// Click-to-select on rows
$list.addEventListener("click", (e) => {
  const li = e.target.closest(".row");
  if (!li) return;
  const idx = [...$list.children].indexOf(li);
  if (idx >= 0) { state.selected = idx; render(); }
});
```

- [ ] **Step 2: Smoke test**

Run `make run`, seed bookmarks, open in browser:

- Arrows ↑/↓ move the selected row marker. Wraps at top/bottom.
- Ctrl+N / Ctrl+P do the same.
- Type `kub` → j/k do NOT navigate (they type into input).
- Clear input. j/k now navigate.
- ⏎ → current tab navigates to the bookmark URL via `/go/:id`. Browser back-button returns to snackpage.
- ⌘+⏎ → opens in a new tab (on macOS).
- Esc → clears query if any, else blurs input.
- `/` while input is unfocused → input refocuses.

Stop the server.

- [ ] **Step 3: Commit**

```bash
git add internal/web/assets/app.js
git commit -m "feat(web): keymap — navigation, open, /, Esc, click-select"
```

---

## Task 19: Frontend Add modal

**Files:**
- Modify: `internal/web/assets/app.js`

- [ ] **Step 1: Append modal logic to `app.js`**

Append:

```javascript
const $modalRoot = document.getElementById("modal-root");

function openModal({ title, initial = {}, onSave }) {
  closeModal(); // ensure single modal
  $modalRoot.innerHTML = `
    <div class="modal-overlay" role="dialog" aria-modal="true">
      <div class="modal">
        <h2><span>${escapeHTML(title)}</span><span class="esc">⎋ to cancel</span></h2>
        <div class="field">
          <label>URL <span style="color:var(--red)">*</span></label>
          <input id="m-url" type="text" value="${escapeHTML(initial.url || "")}" placeholder="https://…">
          <div class="hint">required — validated as a URL on submit</div>
        </div>
        <div class="field">
          <label>Title <span style="color:var(--red)">*</span></label>
          <input id="m-title" type="text" value="${escapeHTML(initial.title || "")}" placeholder="Team Dashboard">
          <div class="hint">defaults to URL hostname if blank</div>
        </div>
        <div class="field">
          <label>Tags</label>
          <input id="m-tags" type="text" value="${escapeHTML((initial.tags || []).join(", "))}" placeholder="work, jira">
          <div class="hint">comma-separated, optional</div>
        </div>
        <div class="field">
          <label>Aliases</label>
          <input id="m-aliases" type="text" value="${escapeHTML((initial.aliases || []).join(", "))}" placeholder="team board, sprint board">
          <div class="hint">extra fuzzy-search keywords, not shown in the list</div>
        </div>
        <div id="m-error" class="error" style="display:none"></div>
        <div class="modal-footer">
          <span>Tab to cycle · ⏎ save · ⎋ cancel</span>
          <div class="actions">
            <button id="m-cancel" class="btn">Cancel</button>
            <button id="m-save" class="btn btn-primary">Save</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const $url = document.getElementById("m-url");
  const $title = document.getElementById("m-title");
  const $tags = document.getElementById("m-tags");
  const $aliases = document.getElementById("m-aliases");
  const $err = document.getElementById("m-error");

  $url.focus();
  $url.select();

  const submit = async () => {
    const url = $url.value.trim();
    if (!url) { showErr("URL is required"); return; }
    let parsed;
    try { parsed = new URL(url); } catch { showErr("URL is not valid"); return; }
    const titleVal = $title.value.trim() || parsed.hostname;
    const tags = $tags.value.split(",").map(s => s.trim()).filter(Boolean);
    const aliases = $aliases.value.split(",").map(s => s.trim()).filter(Boolean);
    try {
      await onSave({ url, title: titleVal, tags, aliases });
      closeModal();
    } catch (err) {
      showErr(err.message || "save failed");
    }
  };

  document.getElementById("m-save").addEventListener("click", submit);
  document.getElementById("m-cancel").addEventListener("click", closeModal);

  $modalRoot.querySelector(".modal").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeModal(); return; }
    if (e.key === "Enter") { e.preventDefault(); submit(); return; }
  });

  function showErr(msg) {
    $err.textContent = msg;
    $err.style.display = "block";
  }
}

function closeModal() {
  $modalRoot.innerHTML = "";
  $q.focus();
}

async function createBookmark(payload) {
  const r = await fetch("/api/bookmarks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  const created = await r.json();
  await load();
  // Auto-select the newly created bookmark
  const idx = state.view.findIndex(b => b.id === created.id);
  if (idx >= 0) { state.selected = idx; render(); }
}
```

- [ ] **Step 2: Wire up ⌘N in the existing keydown handler**

Inside the `document.addEventListener("keydown", ...)` block, before the navigation checks, add:

```javascript
if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
  e.preventDefault();
  openModal({
    title: "Add bookmark",
    onSave: createBookmark,
  });
  return;
}
```

- [ ] **Step 3: Smoke test**

Run `make run` and open in browser:

- ⌘N opens the Add modal with the URL field focused.
- Tab cycles fields: URL → Title → Tags → Aliases → Cancel → Save → URL.
- Fill in a URL, leave Title empty, press ⏎. The hostname becomes the title.
- The new row appears in the picker, auto-selected.
- ⎋ cancels without saving.
- Submitting an invalid URL shows an inline error in red.

Stop the server.

- [ ] **Step 4: Commit**

```bash
git add internal/web/assets/app.js
git commit -m "feat(web): Add modal — ⌘N to create, focus trap, validation"
```

---

## Task 20: Frontend Edit modal + Delete confirm

**Files:**
- Modify: `internal/web/assets/app.js`

- [ ] **Step 1: Add edit + delete logic to `app.js`**

Append:

```javascript
async function updateBookmark(id, payload) {
  const r = await fetch("/api/bookmarks/" + encodeURIComponent(id), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  await load();
}

async function deleteBookmark(id) {
  const r = await fetch("/api/bookmarks/" + encodeURIComponent(id), { method: "DELETE" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  await load();
}

// Delete confirmation state — second ⌘D within 2s within the picker.
let pendingDeleteId = null;
let pendingDeleteTimer = null;

function clearPendingDelete() {
  pendingDeleteId = null;
  if (pendingDeleteTimer) { clearTimeout(pendingDeleteTimer); pendingDeleteTimer = null; }
  $list.querySelectorAll(".row.deleting").forEach(el => el.classList.remove("deleting"));
}

function armOrConfirmDelete() {
  const b = state.view[state.selected];
  if (!b) return;
  if (pendingDeleteId === b.id) {
    clearPendingDelete();
    deleteBookmark(b.id).catch(err => alert("delete failed: " + err.message));
    return;
  }
  clearPendingDelete();
  pendingDeleteId = b.id;
  const row = $list.children[state.selected];
  if (row) row.classList.add("deleting");
  pendingDeleteTimer = setTimeout(clearPendingDelete, 2000);
}
```

- [ ] **Step 2: Wire up ⌘E and ⌘D in the keydown handler**

Inside the existing `document.addEventListener("keydown", ...)` block, alongside the ⌘N branch added in Task 19, add:

```javascript
if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
  e.preventDefault();
  const b = state.view[state.selected];
  if (!b) return;
  openModal({
    title: "Edit bookmark",
    initial: b,
    onSave: (payload) => updateBookmark(b.id, payload),
  });
  return;
}
if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
  e.preventDefault();
  armOrConfirmDelete();
  return;
}
```

Also, at the start of the keydown handler (after the modal-bail-early), clear any pending delete on any other keypress that isn't ⌘D itself:

```javascript
const isCmdD = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d";
if (!isCmdD) clearPendingDelete();
```

Place this immediately after the `if (document.querySelector(".modal-overlay")) return;` line.

- [ ] **Step 3: Smoke test**

Run `make run`, seed bookmarks, open the browser:

- Select a row, press ⌘E → Edit modal opens prefilled with that row's values.
- Change the title, press ⏎ → row updates in place.
- Select a row, press ⌘D → row turns red (delete pending).
- Press ⌘D again within 2s → row disappears.
- Repeat: ⌘D, then press any other key within 2s → red highlight clears, no delete.

Stop the server.

- [ ] **Step 4: Commit**

```bash
git add internal/web/assets/app.js
git commit -m "feat(web): Edit modal (⌘E) and two-tap Delete (⌘D)"
```

---

## Task 21: README — installation, Chrome new-tab override, usage

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite `README.md`**

```markdown
# snackpage

A keyboard-driven, snacks.nvim-inspired bookmark picker served from `localhost`. Built to be your default browser new-tab page so that **Cmd+T → type → Enter** reaches any saved URL in under two seconds.

![v1 design spec](docs/superpowers/specs/2026-05-23-snackpage-design.md)

## Install

Requires Go 1.22+.

```bash
git clone https://github.com/drewvanstone/snackpage.git
cd snackpage
make install            # installs to ~/.local/bin/snackpage
```

Ensure `~/.local/bin` is on your `$PATH`.

## Run

```bash
snackpage serve
# listening on 127.0.0.1:8765
```

First run creates `$XDG_DATA_HOME/snackpage/` (defaults to `~/.local/share/snackpage/`) with empty `bookmarks.json` and `state.json`.

Override the data dir with `--data-dir PATH`, the address with `--addr HOST:PORT`, and the log level with `--log-level debug|info|warn|error`.

## Point your browser at it

`snackpage` serves at `http://127.0.0.1:8765`. The trick is making **Cmd+T** open it instead of the browser's default new-tab page.

### Chrome / Brave / Edge

Chrome's "On startup" setting controls cold-launch only — it does **not** override `Cmd+T`. You have two options:

**Option A: Use a "New Tab Redirect" extension.**

1. Install from the Chrome Web Store: search for "New Tab Redirect" by Justin Henry (or any reputable equivalent — the manifest is trivial).
2. Set the redirect URL to `http://127.0.0.1:8765`.
3. Cmd+T → snackpage.

**Option B: Set the `NewTabPageLocation` Chrome policy.**

```bash
defaults write com.google.Chrome NewTabPageLocation -string "http://127.0.0.1:8765/"
# fully quit and relaunch Chrome
```

This is enterprise policy territory. If your Chrome is managed by your employer, IT policy may override `defaults` settings — verify in `chrome://policy` that `NewTabPageLocation` is `Set by the user`. If it shows `Mandatory` or `Recommended` from your platform policy, use Option A.

### Safari / Vivaldi (native, no extension)

Safari: *Preferences → General → New tabs open with: Homepage*. Set Homepage to `http://127.0.0.1:8765`.

Vivaldi: *Settings → Startup → Start Page → Specific page*. Set to `http://127.0.0.1:8765`.

### Firefox

Install [New Tab Override](https://addons.mozilla.org/firefox/addon/new-tab-override/) and set the URL to `http://127.0.0.1:8765`.

## Use

| Keys | Action |
|---|---|
| `↑` / `↓` / `Ctrl+N` / `Ctrl+P` | Move selection |
| `j` / `k` | Move selection (only when input is empty) |
| `⏎` | Open selected (replaces current tab) |
| `⌘⏎` / `Ctrl+⏎` | Open in a new tab |
| `⌘N` | Add bookmark |
| `⌘E` | Edit selected bookmark |
| `⌘D` | Delete selected — second `⌘D` within 2s confirms |
| `/` | Focus search input |
| `⎋` | Clear search if any, else blur |
| `Tab` / `Shift+Tab` (in modal) | Cycle fields |
| `⏎` (in modal) | Save |
| `⎋` (in modal) | Cancel |

## Storage

```
$XDG_DATA_HOME/snackpage/
├── bookmarks.json   # canonical, hand-editable, safe to back up via git
└── state.json       # visit counts and last-visit timestamps (churns; don't git)
```

To back up: copy `bookmarks.json` anywhere. To restore: drop it back in place.

## Development

```bash
make test       # unit + integration tests with race detector
make lint       # go vet (+ golangci-lint if installed)
make fmt        # gofmt -s -w
make run        # build and serve
```

## Architecture

A single Go binary embeds the entire frontend via `go:embed`. `internal/server` is stdlib `net/http` with mux pattern routing. `internal/store` is a JSON-on-disk store with atomic writes and an in-memory facade. `internal/frecency` is a pure scoring function. The frontend is vanilla JS using a vendored copy of [fzf-for-js](https://github.com/ajitid/fzf-for-js) for ranking.

See [`docs/superpowers/specs/2026-05-23-snackpage-design.md`](docs/superpowers/specs/2026-05-23-snackpage-design.md) for full design rationale and the v2+ roadmap.

## License

MIT. See `NOTICE` for third-party attributions.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: full README with install, new-tab override, keymap"
```

---

## Task 22: End-to-end smoke test + release polish

**Files:**
- Modify: `Makefile` (add `make e2e` target)

- [ ] **Step 1: Add an `e2e` target to `Makefile`**

Append to `Makefile`:

```makefile
e2e: build
	@bash scripts/e2e.sh
```

- [ ] **Step 2: Create `scripts/e2e.sh`**

```bash
#!/usr/bin/env bash
# End-to-end smoke test: start server, exercise the API, kill server.
set -euo pipefail

PORT=18765
DATA=$(mktemp -d)
trap 'kill ${PID:-0} 2>/dev/null || true; rm -rf "$DATA"' EXIT

./snackpage serve --addr "127.0.0.1:${PORT}" --data-dir "$DATA" --log-level error &
PID=$!
sleep 0.3

base="http://127.0.0.1:${PORT}"
expect() {
  local label="$1"; shift
  local want="$1"; shift
  local got
  got=$("$@")
  if [[ "$got" == *"$want"* ]]; then
    echo "  ok: $label"
  else
    echo "  FAIL: $label"
    echo "    want substring: $want"
    echo "    got: $got"
    exit 1
  fi
}

echo "snackpage e2e"

expect "healthz returns ok" "ok" \
  curl -fsS "$base/healthz"

expect "initial bookmarks empty" '"bookmarks":[]' \
  curl -fsS "$base/api/bookmarks"

created=$(curl -fsS -X POST -H 'content-type: application/json' \
  -d '{"title":"E2E","url":"https://example.com/e2e","tags":["test"]}' \
  "$base/api/bookmarks")
id=$(echo "$created" | sed -E 's/.*"id":"([^"]+)".*/\1/')

expect "created bookmark id is 8 crockford chars" "$id" \
  bash -c "echo $id | grep -E '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$'"

expect "redirect bumps visit count" "Location: https://example.com/e2e" \
  bash -c "curl -fsSI '$base/go/$id' | tr -d '\r'"

expect "list shows visit_count=1" '"visit_count":1' \
  curl -fsS "$base/api/bookmarks"

expect "delete returns 204" "204" \
  bash -c "curl -fsS -o /dev/null -w '%{http_code}' -X DELETE '$base/api/bookmarks/$id'"

expect "list empty after delete" '"bookmarks":[]' \
  curl -fsS "$base/api/bookmarks"

echo "snackpage e2e: ALL OK"
```

Then:
```bash
mkdir -p scripts
chmod +x scripts/e2e.sh
```

- [ ] **Step 3: Run the e2e**

```bash
make e2e
```
Expected: every `ok: ...` line prints, then `snackpage e2e: ALL OK`.

- [ ] **Step 4: Run the full Go test suite + lint once more**

```bash
make test
make lint
```
Expected: all green.

- [ ] **Step 5: Tag v1.0.0 and commit the scripts**

```bash
git add Makefile scripts/
git commit -m "test: end-to-end smoke target via scripts/e2e.sh"
git tag -a v1.0.0 -m "snackpage v1.0.0 — first usable release"
git log --oneline
```

Verify the tag appears in `git tag -l`.

- [ ] **Step 6: Manual final verification in actual Chrome**

1. `make install` to put the binary on PATH.
2. `snackpage serve &`
3. Configure Chrome new-tab override per README.
4. Open a new tab (Cmd+T). Confirm snackpage loads.
5. Add a bookmark, search for it, hit Enter, return to snackpage, confirm visit count incremented.
6. Edit it. Delete it. Add three more. Restart `snackpage serve`. Confirm they persisted.

If anything above fails, **do not** push v1.0.0 — file an issue, fix, retest.

---

## Self-review checklist (recorded for executor — do not edit during execution)

Spec section coverage:
- **§3 architecture** → Tasks 0, 8, 9, 13
- **§4 data model** (bookmarks/state files, frecency, IDs, atomic) → Tasks 1, 2, 3, 4, 5, 6, 7
- **§5 HTTP API** → Tasks 9, 10, 11, 12
- **§6 UI behavior + keymap** → Tasks 14, 16, 17, 18, 19, 20
- **§7 CLI** → Task 13
- **§8 project layout** → Tasks 0–13 (assembled file-by-file)
- **§9 testing strategy** → unit tests embedded in each Go task; integration in `internal/server`; e2e in Task 22; frontend manual smoke per task; Playwright deferred to v1.1 per spec
- **§10 roadmap** — v1 only; v1.1/v2/v3/v4 not in this plan, by design
- **§11 open questions** — port 8765 used by default; frecency curve and module name are open-by-spec
