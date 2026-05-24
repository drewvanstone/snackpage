// Package server hosts the snackpage HTTP handlers.
package server

import (
	"io/fs"
	"log/slog"
	"net/http"

	"github.com/drewvanstone/snackpage/internal/store"
	"github.com/drewvanstone/snackpage/internal/web"
)

// Server bundles handler dependencies.
type Server struct {
	store  *store.Store
	logger *slog.Logger
	assets fs.FS
}

// New constructs a Server. The handler is built lazily via Handler().
func New(s *store.Store, l *slog.Logger) *Server {
	sub, err := fs.Sub(web.FS, "assets")
	if err != nil {
		panic("snackpage/server: cannot sub embedded assets: " + err.Error())
	}
	return &Server{store: s, logger: l, assets: sub}
}

// Handler returns the routed http.Handler (with middleware applied).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.handleIndex)
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.FS(s.assets))))
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("GET /api/bookmarks", s.handleListBookmarks)
	mux.HandleFunc("POST /api/bookmarks", s.handleCreateBookmark)
	mux.HandleFunc("PUT /api/bookmarks/{id}", s.handleUpdateBookmark)
	mux.HandleFunc("DELETE /api/bookmarks/{id}", s.handleDeleteBookmark)
	mux.HandleFunc("GET /go/{id}", s.handleRedirect)
	return recoverPanics(s.logger, logRequests(s.logger, mux))
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte("ok"))
}

func (s *Server) handleIndex(w http.ResponseWriter, _ *http.Request) {
	data, err := fs.ReadFile(s.assets, "index.html")
	if err != nil {
		http.Error(w, "index missing", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(data)
}
