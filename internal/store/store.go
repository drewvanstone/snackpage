package store

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

const lockFileName = ".snackpage.lock"

// Store is the in-memory facade over bookmarks.json and state.json.
//
// A Store owns an exclusive process lock on its data directory until Close is
// called. It is safe for concurrent use within that process.
type Store struct {
	dir           string
	bookmarksPath string
	statePath     string

	mu                   sync.RWMutex
	bookmarks            *BookmarksFile
	state                *StateFile
	bookmarksFingerprint [sha256.Size]byte
	lockFile             *os.File
	closed               bool
}

// New loads (or initializes) the store at dir. It creates the directory with
// mode 0700 if needed and initializes both canonical JSON files. The returned
// store must be closed.
func New(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, persistenceError("mkdir data dir", err)
	}

	lockFile, err := os.OpenFile(filepath.Join(dir, lockFileName), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, persistenceError("open store lock", err)
	}
	if err := syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = lockFile.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, fmt.Errorf("%w: %s", ErrLocked, dir)
		}
		return nil, persistenceError("lock store", err)
	}

	s := &Store{
		dir:           dir,
		bookmarksPath: filepath.Join(dir, "bookmarks.json"),
		statePath:     filepath.Join(dir, "state.json"),
		lockFile:      lockFile,
	}
	ok := false
	defer func() {
		if !ok {
			_ = s.releaseLock()
		}
	}()

	b, fingerprint, bookmarksExist, err := loadBookmarksSnapshot(s.bookmarksPath)
	if err != nil {
		return nil, err
	}
	stateMissing := fileMissing(s.statePath)
	st, err := loadState(s.statePath)
	if err != nil {
		switch {
		case errors.Is(err, ErrUnsupportedVersion):
			return nil, err
		case errors.Is(err, ErrValidation) && !stateMissing:
			if _, backupErr := backupInvalidState(s.statePath); backupErr != nil {
				return nil, persistenceError("back up invalid state", backupErr)
			}
			st = emptyStateFile()
			if saveErr := saveState(s.statePath, st); saveErr != nil {
				return nil, persistenceError("reset invalid state", saveErr)
			}
			stateMissing = false
		default:
			return nil, err
		}
	}

	// Validate both existing files before initializing either one. In
	// particular, discovering a future schema must never rewrite or otherwise
	// alter the user's JSON files.
	if !bookmarksExist {
		data, marshalErr := marshalBookmarks(b)
		if marshalErr != nil {
			return nil, persistenceError("encode initial bookmarks", marshalErr)
		}
		if err := atomicWriteFile(s.bookmarksPath, data, 0o600); err != nil {
			return nil, persistenceError("initialize bookmarks", err)
		}
		fingerprint = sha256.Sum256(data)
	}
	if stateMissing {
		if err := saveState(s.statePath, st); err != nil {
			return nil, persistenceError("initialize state", err)
		}
	}

	s.bookmarks = b
	s.state = pruneOrphanStats(st, b)
	s.bookmarksFingerprint = fingerprint
	if len(s.state.Stats) != len(st.Stats) {
		// State is explicitly best-effort. A later successful Visit/Delete will
		// retry persistence if this repair cannot be written now.
		_ = saveState(s.statePath, s.state)
	}
	ok = true
	return s, nil
}

// LoadSnapshot reads the current files without creating a directory or files
// and without acquiring the writer lock. Missing files yield empty snapshots.
// This is intended for read-only operations such as dry-run imports.
func LoadSnapshot(dir string) ([]Bookmark, map[string]Stats, error) {
	b, err := loadBookmarks(filepath.Join(dir, "bookmarks.json"))
	if err != nil {
		return nil, nil, err
	}
	st, err := loadState(filepath.Join(dir, "state.json"))
	if err != nil {
		if errors.Is(err, ErrValidation) {
			// state.json is volatile. A read-only caller can safely use an empty
			// logical state, but must not create a backup or rewrite the file.
			st = emptyStateFile()
		} else {
			return nil, nil, err
		}
	}
	st = pruneOrphanStats(st, b)
	return cloneBookmarks(b.Bookmarks), cloneStats(st.Stats), nil
}

// Close releases the process-level lock. It is safe to call more than once.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	if err := s.releaseLock(); err != nil {
		return persistenceError("release store lock", err)
	}
	return nil
}

func (s *Store) releaseLock() error {
	if s.lockFile == nil {
		return nil
	}
	unlockErr := syscall.Flock(int(s.lockFile.Fd()), syscall.LOCK_UN)
	closeErr := s.lockFile.Close()
	s.lockFile = nil
	return errors.Join(unlockErr, closeErr)
}

// List returns a deep snapshot of bookmarks and stats. Safe for concurrent use.
func (s *Store) List() ([]Bookmark, map[string]Stats) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneBookmarks(s.bookmarks.Bookmarks), cloneStats(s.state.Stats)
}

// Add validates, normalizes, assigns an ID and CreatedAt, persists, and
// returns the stored bookmark.
func (s *Store) Add(b Bookmark) (Bookmark, error) {
	if err := validateBookmark(&b); err != nil {
		return Bookmark{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Bookmark{}, ErrClosed
	}

	ids := bookmarkIDs(s.bookmarks.Bookmarks)
	b.ID = uniqueID(ids)
	b.CreatedAt = time.Now().UTC()
	next := cloneBookmarksFile(s.bookmarks)
	next.Bookmarks = append(next.Bookmarks, cloneBookmark(b))
	if err := s.persistBookmarksLocked(next); err != nil {
		return Bookmark{}, err
	}
	return cloneBookmark(b), nil
}

// AddBatch validates every input before changing anything, skips duplicate
// URLs within the input, optionally skips URLs already in the store, and
// persists all created bookmarks with one atomic canonical write.
func (s *Store) AddBatch(in []Bookmark, skipExistingURLs bool) (created []Bookmark, skipped int, err error) {
	normalized := make([]Bookmark, len(in))
	for i, b := range in {
		if err := validateBookmark(&b); err != nil {
			return nil, 0, fmt.Errorf("bookmark %d: %w", i, err)
		}
		normalized[i] = b
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, 0, ErrClosed
	}

	existingURLs := make(map[string]struct{}, len(s.bookmarks.Bookmarks))
	if skipExistingURLs {
		for _, b := range s.bookmarks.Bookmarks {
			existingURLs[b.URL] = struct{}{}
		}
	}
	seenBatch := make(map[string]struct{}, len(normalized))
	ids := bookmarkIDs(s.bookmarks.Bookmarks)
	now := time.Now().UTC()
	created = make([]Bookmark, 0, len(normalized))
	for _, b := range normalized {
		if _, duplicate := seenBatch[b.URL]; duplicate {
			skipped++
			continue
		}
		seenBatch[b.URL] = struct{}{}
		if _, duplicate := existingURLs[b.URL]; duplicate {
			skipped++
			continue
		}
		b.ID = uniqueID(ids)
		ids[b.ID] = struct{}{}
		b.CreatedAt = now
		created = append(created, b)
	}
	if len(created) == 0 {
		return []Bookmark{}, skipped, nil
	}

	next := cloneBookmarksFile(s.bookmarks)
	for _, b := range created {
		next.Bookmarks = append(next.Bookmarks, cloneBookmark(b))
	}
	if err := s.persistBookmarksLocked(next); err != nil {
		return nil, 0, err
	}
	return cloneBookmarks(created), skipped, nil
}

// Update replaces fields of an existing bookmark by id. It preserves ID and
// CreatedAt.
func (s *Store) Update(id string, in Bookmark) (Bookmark, error) {
	if err := validateBookmark(&in); err != nil {
		return Bookmark{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Bookmark{}, ErrClosed
	}

	next := cloneBookmarksFile(s.bookmarks)
	for i, b := range next.Bookmarks {
		if b.ID != id {
			continue
		}
		in.ID = b.ID
		in.CreatedAt = b.CreatedAt
		next.Bookmarks[i] = cloneBookmark(in)
		if err := s.persistBookmarksLocked(next); err != nil {
			return Bookmark{}, err
		}
		return cloneBookmark(in), nil
	}
	return Bookmark{}, ErrNotFound
}

// Delete removes a bookmark and prunes its stats. bookmarks.json is
// authoritative: once its deletion is durable, a best-effort state cleanup
// failure does not turn the operation into a reported failure.
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrClosed
	}

	next := cloneBookmarksFile(s.bookmarks)
	index := -1
	for i, b := range next.Bookmarks {
		if b.ID == id {
			index = i
			break
		}
	}
	if index < 0 {
		return ErrNotFound
	}
	next.Bookmarks = append(next.Bookmarks[:index], next.Bookmarks[index+1:]...)
	if err := s.persistBookmarksLocked(next); err != nil {
		return err
	}

	nextState := cloneStateFile(s.state)
	delete(nextState.Stats, id)
	s.state = nextState
	_ = saveState(s.statePath, nextState)
	return nil
}

// Visit increments the visit count and updates last_visit_at for id.
func (s *Store) Visit(id string, when time.Time) error {
	if when.IsZero() {
		return fmt.Errorf("%w: visit time is required", ErrValidation)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrClosed
	}
	found := false
	for _, b := range s.bookmarks.Bookmarks {
		if b.ID == id {
			found = true
			break
		}
	}
	if !found {
		return ErrNotFound
	}

	next := cloneStateFile(s.state)
	cur := next.Stats[id]
	cur.VisitCount++
	cur.LastVisitAt = when.UTC()
	next.Stats[id] = cur
	if err := saveState(s.statePath, next); err != nil {
		return persistenceError("save state", err)
	}
	s.state = next
	return nil
}

func (s *Store) persistBookmarksLocked(next *BookmarksFile) error {
	current, err := fingerprintFile(s.bookmarksPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("%w: bookmarks.json was removed", ErrExternalChange)
		}
		return persistenceError("check bookmarks", err)
	}
	if current != s.bookmarksFingerprint {
		return ErrExternalChange
	}
	data, err := marshalBookmarks(next)
	if err != nil {
		return persistenceError("encode bookmarks", err)
	}
	if err := atomicWriteFile(s.bookmarksPath, data, 0o600); err != nil {
		return persistenceError("save bookmarks", err)
	}
	s.bookmarks = next
	s.bookmarksFingerprint = sha256.Sum256(data)
	return nil
}

func validateBookmark(b *Bookmark) error {
	b.Title = strings.TrimSpace(b.Title)
	b.URL = strings.TrimSpace(b.URL)
	if b.Title == "" {
		return fmt.Errorf("%w: title is required", ErrValidation)
	}
	if b.URL == "" {
		return fmt.Errorf("%w: url is required", ErrValidation)
	}
	if !strings.Contains(b.URL, "://") {
		b.URL = "https://" + b.URL
	}
	u, err := url.Parse(b.URL)
	if err != nil {
		return fmt.Errorf("%w: invalid url: %v", ErrValidation, err)
	}
	if u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("%w: url must include scheme and host", ErrValidation)
	}
	b.Tags = normalizeTags(b.Tags)
	b.Aliases = normalizeAliases(b.Aliases)
	return nil
}

func persistenceError(action string, err error) error {
	return fmt.Errorf("%w: %s: %w", ErrPersistence, action, err)
}

func fingerprintFile(path string) ([sha256.Size]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return [sha256.Size]byte{}, err
	}
	return sha256.Sum256(data), nil
}

func fileMissing(path string) bool {
	_, err := os.Stat(path)
	return errors.Is(err, os.ErrNotExist)
}

func bookmarkIDs(bookmarks []Bookmark) map[string]struct{} {
	ids := make(map[string]struct{}, len(bookmarks))
	for _, b := range bookmarks {
		ids[b.ID] = struct{}{}
	}
	return ids
}

func uniqueID(ids map[string]struct{}) string {
	for {
		id := NewID()
		if _, exists := ids[id]; !exists {
			return id
		}
	}
}

func cloneBookmark(b Bookmark) Bookmark {
	b.Tags = append([]string(nil), b.Tags...)
	b.Aliases = append([]string(nil), b.Aliases...)
	return b
}

func cloneBookmarks(in []Bookmark) []Bookmark {
	out := make([]Bookmark, len(in))
	for i, b := range in {
		out[i] = cloneBookmark(b)
	}
	return out
}

func cloneBookmarksFile(in *BookmarksFile) *BookmarksFile {
	return &BookmarksFile{
		Version:   in.Version,
		Bookmarks: cloneBookmarks(in.Bookmarks),
	}
}

func cloneStats(in map[string]Stats) map[string]Stats {
	out := make(map[string]Stats, len(in))
	for id, stats := range in {
		out[id] = stats
	}
	return out
}

func cloneStateFile(in *StateFile) *StateFile {
	return &StateFile{
		Version: in.Version,
		Stats:   cloneStats(in.Stats),
	}
}

func pruneOrphanStats(state *StateFile, bookmarks *BookmarksFile) *StateFile {
	ids := bookmarkIDs(bookmarks.Bookmarks)
	out := cloneStateFile(state)
	for id := range out.Stats {
		if _, exists := ids[id]; !exists {
			delete(out.Stats, id)
		}
	}
	return out
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
