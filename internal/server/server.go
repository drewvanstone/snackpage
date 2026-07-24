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
	// Dev disables HTTP caching on every static asset so iterating with
	// `make dev-run` doesn't fight the browser cache.
	Dev bool
	// Version is the binary's version string (set via -ldflags). When
	// non-empty it's appended as ?v=<version> on script/style tags so a
	// release invalidates stale browser caches.
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
	mux.Handle("GET /{$}", noStore(http.HandlerFunc(s.handleIndex)))
	mux.Handle("GET /manage", noStore(http.HandlerFunc(s.handleManage)))

	static := http.Handler(http.StripPrefix("/static/", http.FileServer(http.FS(s.assets))))
	if s.opts.Dev {
		static = noStore(static)
	} else {
		static = revalidate(static)
	}
	mux.Handle("GET /static/", static)

	mux.Handle("GET /healthz", noStore(http.HandlerFunc(s.handleHealthz)))
	mux.Handle("GET /api/bookmarks", noStore(http.HandlerFunc(s.handleListBookmarks)))
	mux.Handle("POST /api/bookmarks", noStore(http.HandlerFunc(s.handleCreateBookmark)))
	mux.Handle("POST /api/bookmarks/batch", noStore(http.HandlerFunc(s.handleCreateBookmarkBatch)))
	mux.Handle("PUT /api/bookmarks/{id}", noStore(http.HandlerFunc(s.handleUpdateBookmark)))
	mux.Handle("DELETE /api/bookmarks/{id}", noStore(http.HandlerFunc(s.handleDeleteBookmark)))
	// Redirects must reach the server on every navigation so visit counts stay
	// accurate; a cached 302 would bypass the frecency update entirely.
	mux.Handle("GET /go/{id}", noStore(http.HandlerFunc(s.handleRedirect)))
	return recoverPanics(s.logger, logRequests(s.logger, secureLocalRequests(mux)))
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
	_, _ = w.Write(buf.Bytes())
}

// noStore prevents stale HTML and API responses from being reused.
func noStore(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		h.ServeHTTP(w, r)
	})
}

// revalidate permits browsers to retain static assets while requiring a
// conditional request before reuse. Release builds also stamp asset URLs.
func revalidate(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=0, must-revalidate")
		h.ServeHTTP(w, r)
	})
}
