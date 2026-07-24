package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	"github.com/drewvanstone/snackpage/internal/frecency"
	"github.com/drewvanstone/snackpage/internal/store"
)

// bookmarkView is the wire shape: bookmark fields plus stats inline.
type bookmarkView struct {
	store.Bookmark
	VisitCount    int     `json:"visit_count"`
	LastVisitAt   string  `json:"last_visit_at,omitempty"`
	FrecencyScore float64 `json:"frecency_score"`
}

func (s *Server) handleListBookmarks(w http.ResponseWriter, _ *http.Request) {
	bms, stats := s.store.List()
	views := make([]bookmarkView, 0, len(bms))
	now := time.Now().UTC()
	for _, b := range bms {
		st := stats[b.ID]
		v := bookmarkView{
			Bookmark:      b,
			VisitCount:    st.VisitCount,
			FrecencyScore: frecency.Score(st.VisitCount, st.LastVisitAt, now),
		}
		if !st.LastVisitAt.IsZero() {
			v.LastVisitAt = st.LastVisitAt.UTC().Format(time.RFC3339)
		}
		views = append(views, v)
	}
	writeJSON(w, http.StatusOK, map[string]any{"bookmarks": views})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

type bookmarkInput struct {
	Title   string   `json:"title"`
	URL     string   `json:"url"`
	Tags    []string `json:"tags"`
	Aliases []string `json:"aliases"`
}

func (in bookmarkInput) bookmark() store.Bookmark {
	return store.Bookmark{
		Title:   in.Title,
		URL:     in.URL,
		Tags:    in.Tags,
		Aliases: in.Aliases,
	}
}

func (s *Server) handleCreateBookmark(w http.ResponseWriter, r *http.Request) {
	var in bookmarkInput
	if err := decodeJSON(w, r, &in); err != nil {
		writeDecodeError(w, err)
		return
	}
	created, err := s.store.Add(in.bookmark())
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

type bookmarkBatchInput struct {
	Bookmarks        []bookmarkInput `json:"bookmarks"`
	SkipExistingURLs bool            `json:"skip_existing_urls"`
}

func (s *Server) handleCreateBookmarkBatch(w http.ResponseWriter, r *http.Request) {
	var in bookmarkBatchInput
	if err := decodeJSON(w, r, &in); err != nil {
		writeDecodeError(w, err)
		return
	}
	bookmarks := make([]store.Bookmark, len(in.Bookmarks))
	for i := range in.Bookmarks {
		bookmarks[i] = in.Bookmarks[i].bookmark()
	}
	created, skipped, err := s.store.AddBatch(bookmarks, in.SkipExistingURLs)
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"created":          created,
		"skipped_existing": skipped,
	})
}

func (s *Server) handleUpdateBookmark(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var in bookmarkInput
	if err := decodeJSON(w, r, &in); err != nil {
		writeDecodeError(w, err)
		return
	}
	updated, err := s.store.Update(id, in.bookmark())
	if err != nil {
		s.writeStoreError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handleDeleteBookmark(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.store.Delete(id); err != nil {
		s.writeStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

const maxJSONBody = 1 << 20

var (
	errJSONContentType = errors.New("content type must be application/json")
	errJSONTrailing    = errors.New("request body must contain exactly one JSON object")
)

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	contentType := r.Header.Get("Content-Type")
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil || !strings.EqualFold(mediaType, "application/json") {
		return errJSONContentType
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxJSONBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("decode json: %w", err)
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errJSONTrailing
		}
		return fmt.Errorf("decode trailing json: %w", err)
	}
	return nil
}

func writeDecodeError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	switch {
	case errors.Is(err, errJSONContentType):
		writeError(w, http.StatusUnsupportedMediaType, errJSONContentType.Error())
	case errors.As(err, &tooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, "request body is too large")
	default:
		writeError(w, http.StatusBadRequest, "invalid JSON request")
	}
}

func (s *Server) writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "bookmark not found")
	case errors.Is(err, store.ErrValidation):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, store.ErrExternalChange):
		writeError(w, http.StatusConflict, "bookmarks changed outside snackpage; restart before retrying")
	case errors.Is(err, store.ErrLocked):
		writeError(w, http.StatusLocked, "bookmark store is in use")
	case errors.Is(err, store.ErrUnsupportedVersion):
		writeError(w, http.StatusConflict, "bookmark data was written by an unsupported version")
	default:
		s.logger.Error("store_operation_failed", "err", err)
		writeError(w, http.StatusInternalServerError, "could not persist bookmark data")
	}
}
