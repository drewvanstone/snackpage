package store

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Store is the in-memory facade over bookmarks.json and state.json.
type Store struct {
	dir           string
	bookmarksPath string
	statePath     string

	mu        sync.RWMutex
	bookmarks *BookmarksFile
	state     *StateFile
}

// New loads (or initializes) the store at dir. Creates the directory 0700
// if missing.
func New(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("mkdir data dir: %w", err)
	}
	s := &Store{
		dir:           dir,
		bookmarksPath: filepath.Join(dir, "bookmarks.json"),
		statePath:     filepath.Join(dir, "state.json"),
	}
	b, err := loadBookmarks(s.bookmarksPath)
	if err != nil {
		return nil, err
	}
	st, err := loadState(s.statePath)
	if err != nil {
		return nil, err
	}
	s.bookmarks = b
	s.state = st
	return s, nil
}

// List returns a snapshot of bookmarks and stats. Safe for concurrent use.
func (s *Store) List() ([]Bookmark, map[string]Stats) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	bms := make([]Bookmark, len(s.bookmarks.Bookmarks))
	copy(bms, s.bookmarks.Bookmarks)
	stats := make(map[string]Stats, len(s.state.Stats))
	for k, v := range s.state.Stats {
		stats[k] = v
	}
	return bms, stats
}

// Add validates, normalizes, assigns an ID and CreatedAt, persists, and
// returns the stored bookmark.
func (s *Store) Add(b Bookmark) (Bookmark, error) {
	if err := validateBookmark(&b); err != nil {
		return Bookmark{}, err
	}
	b.ID = NewID()
	b.CreatedAt = time.Now().UTC()

	s.mu.Lock()
	defer s.mu.Unlock()
	s.bookmarks.Bookmarks = append(s.bookmarks.Bookmarks, b)
	if err := saveBookmarks(s.bookmarksPath, s.bookmarks); err != nil {
		// roll back in-memory append
		s.bookmarks.Bookmarks = s.bookmarks.Bookmarks[:len(s.bookmarks.Bookmarks)-1]
		return Bookmark{}, err
	}
	return b, nil
}

// Update replaces fields of an existing bookmark by id. Preserves ID and CreatedAt.
func (s *Store) Update(id string, in Bookmark) (Bookmark, error) {
	if err := validateBookmark(&in); err != nil {
		return Bookmark{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, b := range s.bookmarks.Bookmarks {
		if b.ID == id {
			in.ID = b.ID
			in.CreatedAt = b.CreatedAt
			s.bookmarks.Bookmarks[i] = in
			if err := saveBookmarks(s.bookmarksPath, s.bookmarks); err != nil {
				s.bookmarks.Bookmarks[i] = b // roll back
				return Bookmark{}, err
			}
			return in, nil
		}
	}
	return Bookmark{}, errors.New("bookmark not found")
}

// Delete removes a bookmark and prunes its stats.
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, b := range s.bookmarks.Bookmarks {
		if b.ID == id {
			s.bookmarks.Bookmarks = append(s.bookmarks.Bookmarks[:i], s.bookmarks.Bookmarks[i+1:]...)
			delete(s.state.Stats, id)
			if err := saveBookmarks(s.bookmarksPath, s.bookmarks); err != nil {
				return err
			}
			return saveState(s.statePath, s.state)
		}
	}
	return errors.New("bookmark not found")
}

// Visit increments the visit count and updates last_visit_at for id.
// Returns an error if the bookmark does not exist.
func (s *Store) Visit(id string, when time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	found := false
	for _, b := range s.bookmarks.Bookmarks {
		if b.ID == id {
			found = true
			break
		}
	}
	if !found {
		return errors.New("bookmark not found")
	}
	cur := s.state.Stats[id]
	cur.VisitCount++
	cur.LastVisitAt = when.UTC()
	s.state.Stats[id] = cur
	return saveState(s.statePath, s.state)
}

func validateBookmark(b *Bookmark) error {
	b.Title = strings.TrimSpace(b.Title)
	b.URL = strings.TrimSpace(b.URL)
	if b.Title == "" {
		return errors.New("title is required")
	}
	if b.URL == "" {
		return errors.New("url is required")
	}
	// Be permissive about scheme-less input: `google.com` becomes
	// `https://google.com`. Lets users (and the in-page modal) skip the
	// boilerplate without erroring. We only prepend when the input is
	// clearly scheme-less — the absence of `://` is a reliable signal.
	if !strings.Contains(b.URL, "://") {
		b.URL = "https://" + b.URL
	}
	u, err := url.Parse(b.URL)
	if err != nil {
		return fmt.Errorf("invalid url: %w", err)
	}
	if u.Scheme == "" || u.Host == "" {
		return errors.New("url must include scheme and host")
	}
	b.Tags = normalizeTags(b.Tags)
	b.Aliases = normalizeAliases(b.Aliases)
	return nil
}

// normalizeTags trims, lowercases, dedupes and sorts tags. Drops empty strings.
func normalizeTags(in []string) []string {
	if in == nil {
		return []string{}
	}
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, t := range in {
		t = strings.ToLower(strings.TrimSpace(t))
		if t == "" {
			continue
		}
		if _, ok := seen[t]; ok {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
	}
	sort.Strings(out)
	return out
}

// normalizeAliases trims, dedupes (preserving case for display) but does not lowercase.
func normalizeAliases(in []string) []string {
	if in == nil {
		return []string{}
	}
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, a := range in {
		a = strings.TrimSpace(a)
		if a == "" {
			continue
		}
		key := strings.ToLower(a)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, a)
	}
	return out
}
