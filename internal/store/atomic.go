package store

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
)

// atomicWriteFile writes data to path via a temp file in the same directory,
// fsyncs it, then renames over the target. The rename is atomic on the same
// filesystem. Leaves no leftover file on success; on failure, attempts to
// remove the temp file.
func atomicWriteFile(path string, data []byte, perm os.FileMode) error {
	return atomicWriteFileWithParentSync(path, data, perm, func(dir *os.File) error {
		return dir.Sync()
	}, func(err error) {
		// The rename already committed, so returning this as a mutation failure
		// would invite an unsafe retry. Keep the success semantics but make the
		// reduced crash-durability guarantee observable.
		slog.Warn("storage commit may not survive a crash", "path", path, "err", err)
	})
}

// atomicWriteFileWithParentSync exists to make the post-rename commit semantics
// testable. A successful rename is the logical commit point. The parent
// directory is still fsynced for crash durability, but an error after rename is
// not returned: doing so would tell callers to retry an operation that has
// already taken effect and could duplicate it. Such an error is sent to
// reportPostCommit instead. The target is guaranteed to contain data in the
// running system once rename succeeds.
func atomicWriteFileWithParentSync(
	path string,
	data []byte,
	perm os.FileMode,
	syncParent func(*os.File) error,
	reportPostCommit func(error),
) error {
	dirPath := filepath.Dir(path)
	dir, err := os.Open(dirPath)
	if err != nil {
		return fmt.Errorf("open parent dir: %w", err)
	}
	dirClosed := false
	defer func() {
		if !dirClosed {
			_ = dir.Close()
		}
	}()

	f, err := os.CreateTemp(dirPath, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("create tmp: %w", err)
	}
	tmp := f.Name()
	cleanup := func() {
		_ = f.Close()
		_ = os.Remove(tmp)
	}
	if err := f.Chmod(perm); err != nil {
		cleanup()
		return fmt.Errorf("chmod tmp: %w", err)
	}
	if _, err := f.Write(data); err != nil {
		cleanup()
		return fmt.Errorf("write tmp: %w", err)
	}
	if err := f.Sync(); err != nil {
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

	// rename is the logical commit point; do not turn a committed write into a
	// replayable error. Sync is still attempted to make the rename durable
	// across a crash on filesystems that support directory fsync.
	syncErr := syncParent(dir)
	closeErr := dir.Close()
	dirClosed = true
	if warning := errors.Join(
		wrapOptional("fsync parent dir", syncErr),
		wrapOptional("close parent dir", closeErr),
	); warning != nil && reportPostCommit != nil {
		reportPostCommit(warning)
	}
	return nil
}

func wrapOptional(action string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", action, err)
}
