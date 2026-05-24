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

	// Bump stats best-effort — never block the redirect on a disk error.
	if err := s.store.Visit(id, time.Now().UTC()); err != nil {
		s.logger.Warn("visit_record_failed", "id", id, "err", err)
	}
	http.Redirect(w, r, url, http.StatusFound)
}
