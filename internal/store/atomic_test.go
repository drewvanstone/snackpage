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
