package server

import (
	"net/http"
	"time"
)

func (s *Server) handleRedirect(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	// Find bookmark
	bms, _ := s.store.List()
	var url string
	for _, b := range bms {
		if b.ID == id {
			url = b.URL
			break
		}
	}
	if url == "" {
		writeError(w, http.StatusNotFound, "bookmark not found")
		return
	}

	// A HEAD probe must not count as a visit. GET stats remain best-effort so
	// a volatile state-file failure can never block navigation.
	if r.Method == http.MethodGet {
		if err := s.store.Visit(id, time.Now().UTC()); err != nil {
			s.logger.Warn("visit_record_failed", "id", id, "err", err)
		}
	}
	http.Redirect(w, r, url, http.StatusFound)
}
