package store

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
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

func TestAtomicWriteFile_PostRenameSyncFailureIsCommittedSuccess(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "data.json")
	if err := os.WriteFile(target, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}

	syncAttempted := false
	var warning error
	err := atomicWriteFileWithParentSync(
		target,
		[]byte("committed"),
		0o600,
		func(*os.File) error {
			syncAttempted = true
			return errors.New("injected directory sync failure")
		},
		func(err error) {
			warning = err
		},
	)
	if err != nil {
		t.Fatalf("post-rename error was exposed as replayable failure: %v", err)
	}
	if !syncAttempted {
		t.Fatal("parent-directory sync was not attempted")
	}
	if warning == nil || !strings.Contains(warning.Error(), "injected directory sync failure") {
		t.Fatalf("post-commit durability warning = %v; want injected failure", warning)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "committed" {
		t.Fatalf("target = %q; want committed contents", got)
	}
}

func TestAtomicWriteFile_ConcurrentWritersLeaveCompleteFileAndNoTemps(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "data.json")
	const writers = 16
	var wg sync.WaitGroup
	for i := range writers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			content := []byte(strings.Repeat(string(rune('a'+i)), 4096))
			if err := atomicWriteFile(target, content, 0o600); err != nil {
				t.Errorf("atomicWriteFile: %v", err)
			}
		}()
	}
	wg.Wait()

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 4096 {
		t.Fatalf("final file length = %d; want 4096", len(got))
	}
	for _, b := range got {
		if b != got[0] {
			t.Fatal("final file contains bytes from more than one writer")
		}
	}
	temps, err := filepath.Glob(filepath.Join(dir, ".data.json.tmp-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(temps) != 0 {
		t.Fatalf("leftover temporary files: %v", temps)
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
