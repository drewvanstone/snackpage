package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
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

// saveState marshals and atomically writes state.json.
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
