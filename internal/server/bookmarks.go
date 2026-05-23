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
