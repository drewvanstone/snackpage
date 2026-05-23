package server

import (
	"encoding/json"
	"net/http"

	"github.com/drewvanstone/snackpage/internal/store"
)

// bookmarkView is the wire shape: bookmark fields plus stats inline.
type bookmarkView struct {
	store.Bookmark
	VisitCount  int    `json:"visit_count"`
	LastVisitAt string `json:"last_visit_at,omitempty"`
}

func (s *Server) handleListBookmarks(w http.ResponseWriter, _ *http.Request) {
	bms, stats := s.store.List()
	views := make([]bookmarkView, 0, len(bms))
	for _, b := range bms {
		st := stats[b.ID]
		v := bookmarkView{Bookmark: b, VisitCount: st.VisitCount}
		if !st.LastVisitAt.IsZero() {
			v.LastVisitAt = st.LastVisitAt.UTC().Format("2006-01-02T15:04:05Z")
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

func (s *Server) handleCreateBookmark(w http.ResponseWriter, r *http.Request) {
	var in bookmarkInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	created, err := s.store.Add(store.Bookmark{
		Title:   in.Title,
		URL:     in.URL,
		Tags:    in.Tags,
		Aliases: in.Aliases,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) handleUpdateBookmark(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var in bookmarkInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}
	updated, err := s.store.Update(id, store.Bookmark{
		Title:   in.Title,
		URL:     in.URL,
		Tags:    in.Tags,
		Aliases: in.Aliases,
	})
	if err != nil {
		if err.Error() == "bookmark not found" {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handleDeleteBookmark(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := s.store.Delete(id); err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
