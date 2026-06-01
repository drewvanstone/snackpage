// Package server hosts the snackpage HTTP handlers.
package server

import (
	"bytes"
	"html/template"
	"io/fs"
	"log/slog"
	"net/http"

	"github.com/drewvanstone/snackpage/internal/store"
	"github.com/drewvanstone/snackpage/internal/web"
)

// Options bundles runtime tweaks. Zero value is the production default.
type Options struct {
	// Dev disables HTTP caching on every static asset and rendered HTML page
	// so iterating with `make dev-run` doesn't fight the browser cache.
	Dev bool
	// Version is the binary's version string (set via -ldflags). When
	// non-empty it's appended as ?v=<version> on script/style tags so a
	// release invalidates stale browser caches. ES module imports inherit
	// the query of their importing module, so versioning the entry-point
	// app.js cascades to theme.js and friends automatically.
	Version string
}

// Server bundles handler dependencies.
type Server struct {
	store      *store.Store
	logger     *slog.Logger
	assets     fs.FS
	opts       Options
	indexTmpl  *template.Template
	manageTmpl *template.Template
}

// New constructs a Server. The handler is built lazily via Handler().
func New(s *store.Store, l *slog.Logger, opts Options) *Server {
	sub, err := fs.Sub(web.FS, "assets")
	if err != nil {
		panic("snackpage/server: cannot sub embedded assets: " + err.Error())
	}
	indexTmpl, err := template.ParseFS(sub, "index.html")
	if err != nil {
		panic("snackpage/server: cannot parse index.html: " + err.Error())
	}
	manageTmpl, err := template.ParseFS(sub, "manage.html")
	if err != nil {
		panic("snackpage/server: cannot parse manage.html: " + err.Error())
	}
	return &Server{
		store: s, logger: l, assets: sub, opts: opts,
		indexTmpl: indexTmpl, manageTmpl: manageTmpl,
	}
}

// Handler returns the routed http.Handler (with middleware applied).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.handleIndex)
	mux.HandleFunc("GET /manage", s.handleManage)

	static := http.Handler(http.StripPrefix("/static/", http.FileServer(http.FS(s.assets))))
	if s.opts.Dev {
		static = noStore(static)
	}
	mux.Handle("GET /static/", static)

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
	s.renderHTML(w, s.indexTmpl)
}

func (s *Server) handleManage(w http.ResponseWriter, _ *http.Request) {
	s.renderHTML(w, s.manageTmpl)
}

// renderHTML executes a parsed HTML template into a buffer first so a render
// failure can't leak a partially-flushed body to the client.
func (s *Server) renderHTML(w http.ResponseWriter, t *template.Template) {
	var buf bytes.Buffer
	if err := t.Execute(&buf, map[string]string{"Version": s.opts.Version}); err != nil {
		s.logger.Error("template_render", "name", t.Name(), "err", err)
		http.Error(w, "render error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if s.opts.Dev {
		w.Header().Set("Cache-Control", "no-store")
	}
	_, _ = w.Write(buf.Bytes())
}

// noStore disables browser caching on the wrapped handler. Wired only in
// Dev mode so a normal reload after `make dev-run` picks up rebuilt assets.
func noStore(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		h.ServeHTTP(w, r)
	})
}
