package store

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
)

const bookmarksSchemaVersion = 1

// loadBookmarks reads bookmarks.json. Missing file returns an empty file
// at the current schema version; malformed JSON returns an error.
func loadBookmarks(path string) (*BookmarksFile, error) {
	bookmarks, _, _, err := loadBookmarksSnapshot(path)
	return bookmarks, err
}

// loadBookmarksSnapshot parses and fingerprints the same read. Keeping those
// operations together prevents an external edit between loading the in-memory
// snapshot and recording the fingerprint used for conflict detection.
func loadBookmarksSnapshot(path string) (*BookmarksFile, [sha256.Size]byte, bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &BookmarksFile{
				Version:   bookmarksSchemaVersion,
				Bookmarks: []Bookmark{},
			}, [sha256.Size]byte{}, false, nil
		}
		return nil, [sha256.Size]byte{}, false, persistenceError("read bookmarks", err)
	}
	var header struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(data, &header); err == nil && header.Version != bookmarksSchemaVersion {
		return nil, [sha256.Size]byte{}, true, fmt.Errorf("%w: bookmarks version %d (want %d)",
			ErrUnsupportedVersion, header.Version, bookmarksSchemaVersion)
	}
	var out BookmarksFile
	if err := decodeStrictJSON(data, &out); err != nil {
		return nil, [sha256.Size]byte{}, true, fmt.Errorf("%w: parse bookmarks: %v", ErrValidation, err)
	}
	if out.Bookmarks == nil {
		out.Bookmarks = []Bookmark{}
	}
	if err := validateBookmarksFile(&out); err != nil {
		return nil, [sha256.Size]byte{}, true, err
	}
	return &out, sha256.Sum256(data), true, nil
}

// saveBookmarks marshals and atomically writes bookmarks.json.
func saveBookmarks(path string, f *BookmarksFile) error {
	data, err := marshalBookmarks(f)
	if err != nil {
		return fmt.Errorf("encode bookmarks: %w", err)
	}
	return atomicWriteFile(path, data, 0o600)
}

func marshalBookmarks(f *BookmarksFile) ([]byte, error) {
	out := cloneBookmarksFile(f)
	if out.Bookmarks == nil {
		out.Bookmarks = []Bookmark{}
	}
	out.Version = bookmarksSchemaVersion
	return json.MarshalIndent(out, "", "  ")
}

func validateBookmarksFile(f *BookmarksFile) error {
	if f.Version != bookmarksSchemaVersion {
		return fmt.Errorf("%w: bookmarks version %d (want %d)",
			ErrUnsupportedVersion, f.Version, bookmarksSchemaVersion)
	}
	seen := make(map[string]struct{}, len(f.Bookmarks))
	for i := range f.Bookmarks {
		b := &f.Bookmarks[i]
		if !validID(b.ID) {
			return fmt.Errorf("%w: bookmark %d has invalid id %q", ErrValidation, i, b.ID)
		}
		if _, ok := seen[b.ID]; ok {
			return fmt.Errorf("%w: duplicate bookmark id %q", ErrValidation, b.ID)
		}
		seen[b.ID] = struct{}{}
		if strings.TrimSpace(b.Title) == "" {
			return fmt.Errorf("%w: bookmark %q has an empty title", ErrValidation, b.ID)
		}
		rawURL := strings.TrimSpace(b.URL)
		u, err := url.Parse(rawURL)
		if err != nil || u.Scheme == "" || u.Host == "" {
			return fmt.Errorf("%w: bookmark %q has invalid url %q", ErrValidation, b.ID, b.URL)
		}
		if b.CreatedAt.IsZero() {
			return fmt.Errorf("%w: bookmark %q has an empty created_at", ErrValidation, b.ID)
		}
	}
	return nil
}

func decodeStrictJSON(data []byte, dst any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func validID(id string) bool {
	if len(id) != 8 {
		return false
	}
	for _, r := range id {
		if !strings.ContainsRune(crockfordAlphabet, r) {
			return false
		}
	}
	return true
}
