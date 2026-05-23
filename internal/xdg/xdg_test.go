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
