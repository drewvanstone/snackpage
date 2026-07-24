package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const stateSchemaVersion = 1

// loadState reads state.json. Missing file returns an empty file at the
// current schema version; malformed JSON returns an error.
func loadState(path string) (*StateFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &StateFile{
				Version: stateSchemaVersion,
				Stats:   map[string]Stats{},
			}, nil
		}
		return nil, persistenceError("read state", err)
	}
	var header struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(data, &header); err == nil && header.Version != stateSchemaVersion {
		return nil, fmt.Errorf("%w: state version %d (want %d)",
			ErrUnsupportedVersion, header.Version, stateSchemaVersion)
	}
	var out StateFile
	if err := decodeStrictJSON(data, &out); err != nil {
		return nil, fmt.Errorf("%w: parse state: %v", ErrValidation, err)
	}
	if out.Stats == nil {
		out.Stats = map[string]Stats{}
	}
	if err := validateStateFile(&out); err != nil {
		return nil, err
	}
	return &out, nil
}

// saveState marshals and atomically writes state.json.
func saveState(path string, f *StateFile) error {
	out := cloneStateFile(f)
	if out.Stats == nil {
		out.Stats = map[string]Stats{}
	}
	out.Version = stateSchemaVersion
	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return fmt.Errorf("encode state: %w", err)
	}
	return atomicWriteFile(path, data, 0o600)
}

func validateStateFile(f *StateFile) error {
	if f.Version != stateSchemaVersion {
		return fmt.Errorf("%w: state version %d (want %d)",
			ErrUnsupportedVersion, f.Version, stateSchemaVersion)
	}
	for id, stats := range f.Stats {
		if !validID(id) {
			return fmt.Errorf("%w: state has invalid bookmark id %q", ErrValidation, id)
		}
		if stats.VisitCount < 0 {
			return fmt.Errorf("%w: state for %q has negative visit_count", ErrValidation, id)
		}
		if stats.VisitCount == 0 && !stats.LastVisitAt.IsZero() {
			return fmt.Errorf("%w: state for %q has last_visit_at without a visit", ErrValidation, id)
		}
		if stats.VisitCount > 0 && stats.LastVisitAt.IsZero() {
			return fmt.Errorf("%w: state for %q has visits without last_visit_at", ErrValidation, id)
		}
	}
	return nil
}

func emptyStateFile() *StateFile {
	return &StateFile{
		Version: stateSchemaVersion,
		Stats:   map[string]Stats{},
	}
}

// backupInvalidState writes an exact, uniquely named, durable copy next to
// state.json. The original remains in place until the caller atomically
// replaces it with a clean state file.
func backupInvalidState(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read invalid state: %w", err)
	}
	dirPath := filepath.Dir(path)
	f, err := os.CreateTemp(dirPath, filepath.Base(path)+".recovery-*")
	if err != nil {
		return "", fmt.Errorf("create state recovery: %w", err)
	}
	backupPath := f.Name()
	keep := false
	defer func() {
		_ = f.Close()
		if !keep {
			_ = os.Remove(backupPath)
		}
	}()
	if err := f.Chmod(0o600); err != nil {
		return "", fmt.Errorf("chmod state recovery: %w", err)
	}
	if _, err := f.Write(data); err != nil {
		return "", fmt.Errorf("write state recovery: %w", err)
	}
	if err := f.Sync(); err != nil {
		return "", fmt.Errorf("fsync state recovery: %w", err)
	}
	if err := f.Close(); err != nil {
		return "", fmt.Errorf("close state recovery: %w", err)
	}
	dir, err := os.Open(dirPath)
	if err != nil {
		return "", fmt.Errorf("open recovery parent dir: %w", err)
	}
	if err := dir.Sync(); err != nil {
		_ = dir.Close()
		return "", fmt.Errorf("fsync recovery parent dir: %w", err)
	}
	if err := dir.Close(); err != nil {
		return "", fmt.Errorf("close recovery parent dir: %w", err)
	}
	keep = true
	return backupPath, nil
}
