package store

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestNewInitializesFilesAndOwnsExclusiveLock(t *testing.T) {
	dir := t.TempDir()
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}

	for _, name := range []string{"bookmarks.json", "state.json"} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("%s was not initialized: %v", name, err)
		}
		if got := info.Mode().Perm(); got != 0o600 {
			t.Errorf("%s mode = %#o; want 0600", name, got)
		}
	}

	if _, err := New(dir); !errors.Is(err, ErrLocked) {
		t.Fatalf("second New error = %v; want ErrLocked", err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}

	reopened, err := New(dir)
	if err != nil {
		t.Fatalf("New after Close: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
}

func TestStoreLockAcrossProcesses(t *testing.T) {
	dir := t.TempDir()
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	cmd := exec.Command(os.Args[0], "-test.run=^TestStoreLockHelper$")
	cmd.Env = append(os.Environ(),
		"SNACKPAGE_STORE_LOCK_HELPER=1",
		"SNACKPAGE_STORE_LOCK_DIR="+dir,
	)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("lock helper failed: %v\n%s", err, output)
	}
}

func TestStoreLockHelper(t *testing.T) {
	if os.Getenv("SNACKPAGE_STORE_LOCK_HELPER") != "1" {
		t.Skip("helper process only")
	}
	dir := os.Getenv("SNACKPAGE_STORE_LOCK_DIR")
	if _, err := New(dir); !errors.Is(err, ErrLocked) {
		t.Fatalf("New error = %v; want ErrLocked", err)
	}
}

func TestNewRejectsFutureSchemaWithoutChangingCanonicalFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bookmarks.json")
	original := []byte(`{"version":99,"bookmarks":[]}`)
	if err := os.WriteFile(path, original, 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := New(dir)
	if !errors.Is(err, ErrUnsupportedVersion) {
		t.Fatalf("New error = %v; want ErrUnsupportedVersion", err)
	}
	after, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(after) != string(original) {
		t.Fatalf("future-version file changed:\ngot  %s\nwant %s", after, original)
	}
}

func TestNewRecoversInvalidVolatileState(t *testing.T) {
	tests := []struct {
		name string
		raw  []byte
	}{
		{
			name: "malformed JSON",
			raw:  []byte(`{"version":1,"stats":`),
		},
		{
			name: "inconsistent current schema",
			raw:  []byte(`{"version":1,"stats":{"B7K3M2QA":{"visit_count":1}}}`),
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			statePath := filepath.Join(dir, "state.json")
			if err := os.WriteFile(statePath, tc.raw, 0o600); err != nil {
				t.Fatal(err)
			}

			s, err := New(dir)
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			t.Cleanup(func() { _ = s.Close() })
			_, stats := s.List()
			if len(stats) != 0 {
				t.Fatalf("recovered stats = %+v; want empty", stats)
			}

			backups, err := filepath.Glob(statePath + ".recovery-*")
			if err != nil {
				t.Fatal(err)
			}
			if len(backups) != 1 {
				t.Fatalf("recovery files = %v; want exactly one", backups)
			}
			backup, err := os.ReadFile(backups[0])
			if err != nil {
				t.Fatal(err)
			}
			if string(backup) != string(tc.raw) {
				t.Fatalf("recovery contents = %q; want %q", backup, tc.raw)
			}
			recovered, err := loadState(statePath)
			if err != nil {
				t.Fatalf("load recovered state: %v", err)
			}
			if recovered.Version != stateSchemaVersion || len(recovered.Stats) != 0 {
				t.Fatalf("recovered state = %+v; want current empty state", recovered)
			}
		})
	}
}

func TestNewRejectsFutureStateUntouched(t *testing.T) {
	dir := t.TempDir()
	statePath := filepath.Join(dir, "state.json")
	original := []byte(`{"version":99,"stats":{},"future_field":true}`)
	if err := os.WriteFile(statePath, original, 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := New(dir)
	if !errors.Is(err, ErrUnsupportedVersion) {
		t.Fatalf("New error = %v; want ErrUnsupportedVersion", err)
	}
	after, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(original) {
		t.Fatalf("future state changed:\ngot  %s\nwant %s", after, original)
	}
	backups, err := filepath.Glob(statePath + ".recovery-*")
	if err != nil {
		t.Fatal(err)
	}
	if len(backups) != 0 {
		t.Fatalf("future state was backed up as invalid: %v", backups)
	}
	if _, err := os.Stat(filepath.Join(dir, "bookmarks.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("New touched bookmarks before rejecting future state: %v", err)
	}
}

func TestStoreDetectsExternalCanonicalChange(t *testing.T) {
	dir := t.TempDir()
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	before, err := os.ReadFile(s.bookmarksPath)
	if err != nil {
		t.Fatal(err)
	}
	externallyChanged := append(append([]byte(nil), before...), '\n')
	if err := os.WriteFile(s.bookmarksPath, externallyChanged, 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := s.Add(Bookmark{Title: "new", URL: "example.com"}); !errors.Is(err, ErrExternalChange) {
		t.Fatalf("Add error = %v; want ErrExternalChange", err)
	}
	bookmarks, _ := s.List()
	if len(bookmarks) != 0 {
		t.Fatalf("failed Add changed memory: %+v", bookmarks)
	}
	after, err := os.ReadFile(s.bookmarksPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(externallyChanged) {
		t.Fatal("failed Add overwrote the external edit")
	}
}

func TestListAndResultsAreDeepCopies(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	input := Bookmark{
		Title:   "Example",
		URL:     "example.com",
		Tags:    []string{"one"},
		Aliases: []string{"first"},
	}
	added, err := s.Add(input)
	if err != nil {
		t.Fatal(err)
	}
	input.Tags[0] = "input-mutated"
	added.Tags[0] = "result-mutated"

	first, _ := s.List()
	first[0].Tags[0] = "snapshot-mutated"
	first[0].Aliases[0] = "snapshot-mutated"
	second, _ := s.List()
	if second[0].Tags[0] != "one" || second[0].Aliases[0] != "first" {
		t.Fatalf("nested slices aliased store memory: %+v", second[0])
	}
}

func TestAddBatchAllOrNothingAndDeduplicates(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	if _, err := s.Add(Bookmark{Title: "Existing", URL: "https://existing.example"}); err != nil {
		t.Fatal(err)
	}
	before, _ := s.List()
	if _, _, err := s.AddBatch([]Bookmark{
		{Title: "valid", URL: "valid.example"},
		{Title: "", URL: "invalid.example"},
	}, true); !errors.Is(err, ErrValidation) {
		t.Fatalf("invalid batch error = %v; want ErrValidation", err)
	}
	afterInvalid, _ := s.List()
	if len(afterInvalid) != len(before) {
		t.Fatalf("invalid batch partially persisted: %+v", afterInvalid)
	}

	created, skipped, err := s.AddBatch([]Bookmark{
		{Title: "already there", URL: "https://existing.example"},
		{Title: "new", URL: "new.example", Tags: []string{"B", "b"}},
		{Title: "same URL twice", URL: "https://new.example"},
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(created) != 1 || skipped != 2 {
		t.Fatalf("created=%d skipped=%d; want 1, 2", len(created), skipped)
	}
	if created[0].URL != "https://new.example" {
		t.Errorf("created URL = %q", created[0].URL)
	}
	all, _ := s.List()
	if len(all) != 2 {
		t.Fatalf("stored %d bookmarks; want 2", len(all))
	}
}

func TestCanonicalMutationFailuresDoNotPublishMemoryOrDisk(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	existing, err := s.Add(Bookmark{Title: "Existing", URL: "existing.example"})
	if err != nil {
		t.Fatal(err)
	}

	before, _ := s.List()
	beforeJSON, err := json.Marshal(before)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(s.bookmarksPath)
	if err != nil {
		t.Fatal(err)
	}
	s.bookmarksPath = canonicalPathWithUncreatableTemp(t, s.dir, raw)

	mutations := []struct {
		name string
		run  func() error
	}{
		{
			name: "add",
			run: func() error {
				_, err := s.Add(Bookmark{Title: "Add", URL: "add.example"})
				return err
			},
		},
		{
			name: "batch",
			run: func() error {
				_, _, err := s.AddBatch(
					[]Bookmark{{Title: "Batch", URL: "batch.example"}},
					true,
				)
				return err
			},
		},
		{
			name: "update",
			run: func() error {
				_, err := s.Update(
					existing.ID,
					Bookmark{Title: "Updated", URL: "updated.example"},
				)
				return err
			},
		},
		{
			name: "delete",
			run: func() error {
				return s.Delete(existing.ID)
			},
		},
	}

	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			if err := mutation.run(); !errors.Is(err, ErrPersistence) {
				t.Fatalf("mutation error = %v; want ErrPersistence", err)
			}
			after, _ := s.List()
			afterJSON, err := json.Marshal(after)
			if err != nil {
				t.Fatal(err)
			}
			if string(afterJSON) != string(beforeJSON) {
				t.Fatalf("failed mutation changed memory:\ngot  %s\nwant %s", afterJSON, beforeJSON)
			}
			afterDisk, err := os.ReadFile(s.bookmarksPath)
			if err != nil {
				t.Fatal(err)
			}
			if string(afterDisk) != string(raw) {
				t.Fatal("failed mutation changed canonical bytes")
			}
		})
	}
}

// canonicalPathWithUncreatableTemp creates a readable canonical file whose
// basename fits the filesystem but whose longer atomic-write temp template
// does not. This reliably injects a pre-rename persistence failure without
// permission assumptions (tests may run as root).
func canonicalPathWithUncreatableTemp(t *testing.T, dir string, data []byte) string {
	t.Helper()
	for length := 255; length >= 64; length-- {
		path := filepath.Join(dir, strings.Repeat("b", length))
		if err := os.WriteFile(path, data, 0o600); err != nil {
			continue
		}
		probe, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
		if err != nil {
			return path
		}
		probePath := probe.Name()
		if closeErr := probe.Close(); closeErr != nil {
			t.Fatal(closeErr)
		}
		if removeErr := os.Remove(probePath); removeErr != nil {
			t.Fatal(removeErr)
		}
		if removeErr := os.Remove(path); removeErr != nil {
			t.Fatal(removeErr)
		}
	}
	t.Fatal("could not construct a canonical path with an uncreatable temp sibling")
	return ""
}

func TestVisitFailureDoesNotMutateMemory(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	b, err := s.Add(Bookmark{Title: "Example", URL: "example.com"})
	if err != nil {
		t.Fatal(err)
	}

	s.statePath = s.dir // writing over a directory always fails
	if err := s.Visit(b.ID, time.Now()); !errors.Is(err, ErrPersistence) {
		t.Fatalf("Visit error = %v; want ErrPersistence", err)
	}
	_, stats := s.List()
	if _, exists := stats[b.ID]; exists {
		t.Fatalf("failed Visit changed memory: %+v", stats[b.ID])
	}
}

func TestDeleteSucceedsWhenBestEffortStateCleanupFails(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	b, err := s.Add(Bookmark{Title: "Example", URL: "example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Visit(b.ID, time.Now()); err != nil {
		t.Fatal(err)
	}

	s.statePath = s.dir
	if err := s.Delete(b.ID); err != nil {
		t.Fatalf("Delete returned state cleanup failure: %v", err)
	}
	bookmarks, stats := s.List()
	if len(bookmarks) != 0 {
		t.Fatalf("bookmark was not deleted: %+v", bookmarks)
	}
	if _, exists := stats[b.ID]; exists {
		t.Fatalf("in-memory orphan state was not pruned: %+v", stats)
	}
}

func TestNewPrunesAndRepairsOrphanStats(t *testing.T) {
	dir := t.TempDir()
	bookmarks := &BookmarksFile{
		Version: bookmarksSchemaVersion,
		Bookmarks: []Bookmark{{
			ID:        "B7K3M2QA",
			Title:     "Kept",
			URL:       "https://example.com",
			Tags:      []string{},
			Aliases:   []string{},
			CreatedAt: time.Now().UTC(),
		}},
	}
	state := &StateFile{
		Version: stateSchemaVersion,
		Stats: map[string]Stats{
			"B7K3M2QA": {VisitCount: 1, LastVisitAt: time.Now().UTC()},
			"Z7K3M2QA": {VisitCount: 2, LastVisitAt: time.Now().UTC()},
		},
	}
	if err := saveBookmarks(filepath.Join(dir, "bookmarks.json"), bookmarks); err != nil {
		t.Fatal(err)
	}
	if err := saveState(filepath.Join(dir, "state.json"), state); err != nil {
		t.Fatal(err)
	}

	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	_, stats := s.List()
	if len(stats) != 1 || stats["B7K3M2QA"].VisitCount != 1 {
		t.Fatalf("stats after prune = %+v", stats)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	var persisted StateFile
	if err := json.Unmarshal(raw, &persisted); err != nil {
		t.Fatal(err)
	}
	if _, exists := persisted.Stats["Z7K3M2QA"]; exists {
		t.Fatal("orphan stat remained on disk")
	}
}

func TestLoadSnapshotMissingDirectoryDoesNotCreateIt(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "does-not-exist")
	bookmarks, stats, err := LoadSnapshot(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(bookmarks) != 0 || len(stats) != 0 {
		t.Fatalf("snapshot = %+v, %+v; want empty", bookmarks, stats)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("LoadSnapshot created its directory or returned unexpected stat error: %v", err)
	}
}

func TestLoadSnapshotToleratesInvalidStateWithoutWriting(t *testing.T) {
	dir := t.TempDir()
	statePath := filepath.Join(dir, "state.json")
	original := []byte(`{"version":1,"stats":{"B7K3M2QA":{"visit_count":1}}}`)
	if err := os.WriteFile(statePath, original, 0o600); err != nil {
		t.Fatal(err)
	}

	bookmarks, stats, err := LoadSnapshot(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(bookmarks) != 0 || len(stats) != 0 {
		t.Fatalf("snapshot = %+v, %+v; want empty", bookmarks, stats)
	}
	after, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(original) {
		t.Fatal("read-only snapshot rewrote invalid state")
	}
	backups, err := filepath.Glob(statePath + ".recovery-*")
	if err != nil {
		t.Fatal(err)
	}
	if len(backups) != 0 {
		t.Fatalf("read-only snapshot created recovery files: %v", backups)
	}
}

func TestLoadSnapshotRejectsFutureState(t *testing.T) {
	dir := t.TempDir()
	statePath := filepath.Join(dir, "state.json")
	original := []byte(`{"version":2,"stats":{}}`)
	if err := os.WriteFile(statePath, original, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := LoadSnapshot(dir); !errors.Is(err, ErrUnsupportedVersion) {
		t.Fatalf("LoadSnapshot error = %v; want ErrUnsupportedVersion", err)
	}
	after, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(original) {
		t.Fatal("read-only snapshot rewrote future state")
	}
}

func TestVisitRejectsZeroTimestampWithoutMutation(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	b, err := s.Add(Bookmark{Title: "Example", URL: "example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Visit(b.ID, time.Time{}); !errors.Is(err, ErrValidation) {
		t.Fatalf("Visit error = %v; want ErrValidation", err)
	}
	_, stats := s.List()
	if len(stats) != 0 {
		t.Fatalf("zero-time Visit changed stats: %+v", stats)
	}
}

func TestConcurrentAdds(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })

	const count = 32
	var wg sync.WaitGroup
	errs := make(chan error, count)
	for range count {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.Add(Bookmark{Title: "Example", URL: "example.com"})
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("Add: %v", err)
		}
	}

	bookmarks, _ := s.List()
	if len(bookmarks) != count {
		t.Fatalf("stored %d bookmarks; want %d", len(bookmarks), count)
	}
	ids := bookmarkIDs(bookmarks)
	if len(ids) != count {
		t.Fatalf("stored duplicate IDs: %+v", bookmarks)
	}
}
