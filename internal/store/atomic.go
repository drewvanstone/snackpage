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
