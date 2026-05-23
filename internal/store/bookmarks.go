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
