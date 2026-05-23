package store

import "time"

// Bookmark is a single user-managed entry. Stable across edits.
type Bookmark struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	URL       string    `json:"url"`
	Tags      []string  `json:"tags"`
	Aliases   []string  `json:"aliases"`
	CreatedAt time.Time `json:"created_at"`
}

// Stats is the volatile state for a single bookmark.
type Stats struct {
	VisitCount  int       `json:"visit_count"`
	LastVisitAt time.Time `json:"last_visit_at,omitempty"`
}

// BookmarksFile is the on-disk shape of bookmarks.json.
type BookmarksFile struct {
	Version   int        `json:"version"`
	Bookmarks []Bookmark `json:"bookmarks"`
}

// StateFile is the on-disk shape of state.json.
type StateFile struct {
	Version int              `json:"version"`
	Stats   map[string]Stats `json:"stats"`
}
