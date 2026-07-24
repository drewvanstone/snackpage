package store

import "errors"

var (
	// ErrNotFound indicates that a bookmark ID does not exist.
	ErrNotFound = errors.New("bookmark not found")
	// ErrLocked indicates that another process already owns the data directory.
	ErrLocked = errors.New("store is locked")
	// ErrExternalChange indicates that bookmarks.json changed after the store
	// opened. The caller must close and reopen the store before writing.
	ErrExternalChange = errors.New("bookmarks changed outside snackpage")
	// ErrValidation indicates invalid bookmark or on-disk data.
	ErrValidation = errors.New("validation failed")
	// ErrPersistence indicates an I/O or encoding failure.
	ErrPersistence = errors.New("persistence failed")
	// ErrUnsupportedVersion indicates an on-disk schema this binary cannot read.
	ErrUnsupportedVersion = errors.New("unsupported schema version")
	// ErrClosed indicates a write attempted after Store.Close.
	ErrClosed = errors.New("store is closed")
)
