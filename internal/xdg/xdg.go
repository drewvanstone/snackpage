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
