package server

import (
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// logRequests is a tiny access-log middleware.
func logRequests(l *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		l.Info("http",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"dur_ms", time.Since(start).Milliseconds(),
		)
	})
}

// recoverPanics turns a handler panic into a 500.
func recoverPanics(l *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				l.Error("panic", "panic", rec, "path", r.URL.Path)
				http.Error(w, "internal server error", http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// secureLocalRequests rejects hostile Host headers and cross-origin writes.
// The process also refuses non-loopback listen addresses; these checks are a
// second line of defense for browsers and reverse-proxy mistakes.
func secureLocalRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setSecurityHeaders(w.Header())
		if !isLoopbackHost(r.Host) {
			writeError(w, http.StatusBadRequest, "invalid host")
			return
		}
		if isMutation(r.Method) && !sameOrigin(r) {
			writeError(w, http.StatusForbidden, "cross-origin request denied")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func setSecurityHeaders(h http.Header) {
	h.Set("Content-Security-Policy", "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'")
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
	h.Set("Permissions-Policy", "camera=(), geolocation=(), microphone=()")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
}

func isMutation(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}

func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		// Native clients do not send Origin. Host validation and loopback-only
		// binding still constrain these requests to the local machine.
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return false
	}
	requestScheme := "http"
	if r.TLS != nil {
		requestScheme = "https"
	}
	return strings.EqualFold(u.Scheme, requestScheme) &&
		u.User == nil &&
		(u.Path == "" || u.Path == "/") &&
		u.RawQuery == "" &&
		u.Fragment == "" &&
		equalHostPort(u.Host, r.Host)
}

func equalHostPort(a, b string) bool {
	return strings.EqualFold(strings.TrimSuffix(a, "."), strings.TrimSuffix(b, "."))
}

func isLoopbackHost(hostport string) bool {
	host := hostport
	if parsedHost, _, err := net.SplitHostPort(hostport); err == nil {
		host = parsedHost
	} else if strings.HasPrefix(hostport, "[") && strings.HasSuffix(hostport, "]") {
		host = strings.Trim(hostport, "[]")
	}
	host = strings.TrimSuffix(host, ".")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
