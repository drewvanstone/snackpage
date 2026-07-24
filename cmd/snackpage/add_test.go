package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"syscall"
	"testing"

	"github.com/drewvanstone/snackpage/internal/store"
)

func TestRunAddNormalizesBareURLAndFallsBackOnlyWhenRefused(t *testing.T) {
	addr := closedLoopbackAddress(t)
	dir := t.TempDir()

	code := runAdd([]string{
		"example.com/docs",
		"--title", "Example",
		"--addr", addr,
		"--data-dir", dir,
	})
	if code != 0 {
		t.Fatalf("runAdd code = %d; want 0", code)
	}
	bookmarks, _, err := store.LoadSnapshot(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(bookmarks) != 1 || bookmarks[0].URL != "https://example.com/docs" {
		t.Fatalf("bookmarks = %+v", bookmarks)
	}
}

func TestRunAddDoesNotRetryMalformedSuccessfulResponse(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer ts.Close()
	dir := t.TempDir()

	code := runAdd([]string{
		"https://example.com",
		"--title", "Example",
		"--addr", strings.TrimPrefix(ts.URL, "http://"),
		"--data-dir", dir,
	})
	if code != 1 {
		t.Fatalf("runAdd code = %d; want 1", code)
	}
	bookmarks, _, err := store.LoadSnapshot(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(bookmarks) != 0 {
		t.Fatalf("ambiguous response caused direct retry: %+v", bookmarks)
	}
}

func TestRunAddDoesNotRetryHTTPRejection(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "no", http.StatusBadRequest)
	}))
	defer ts.Close()
	dir := t.TempDir()

	code := runAdd([]string{
		"https://example.com",
		"--title", "Example",
		"--addr", strings.TrimPrefix(ts.URL, "http://"),
		"--data-dir", dir,
	})
	if code != 1 {
		t.Fatalf("runAdd code = %d; want 1", code)
	}
	bookmarks, _, err := store.LoadSnapshot(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(bookmarks) != 0 {
		t.Fatalf("HTTP rejection caused direct retry: %+v", bookmarks)
	}
}

func TestRunAddOfflineBypassesDaemonAddress(t *testing.T) {
	dir := t.TempDir()
	code := runAdd([]string{
		"https://example.com",
		"--title", "Example",
		"--offline",
		"--addr", "203.0.113.10:8765",
		"--data-dir", dir,
	})
	if code != 0 {
		t.Fatalf("runAdd code = %d; want 0", code)
	}
	bookmarks, _, err := store.LoadSnapshot(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(bookmarks) != 1 {
		t.Fatalf("bookmarks = %+v", bookmarks)
	}
}

func TestRunAddOfflineRespectsStoreLock(t *testing.T) {
	dir := t.TempDir()
	owner, err := store.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := owner.Close(); err != nil {
			t.Errorf("close owner: %v", err)
		}
	}()

	code := runAdd([]string{
		"https://example.com",
		"--title", "Example",
		"--offline",
		"--data-dir", dir,
	})
	if code != 1 {
		t.Fatalf("runAdd code = %d; want 1 while daemon lock is held", code)
	}
	bookmarks, _ := owner.List()
	if len(bookmarks) != 0 {
		t.Fatalf("locked offline write changed owner snapshot: %+v", bookmarks)
	}
}

func TestPostBookmarkBatchValidatesSuccessfulResponse(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Bookmarks []bookmarkPayload `json:"bookmarks"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"created":[],"skipped_existing":0}`))
	}))
	defer ts.Close()

	_, err := postBookmarkBatch(strings.TrimPrefix(ts.URL, "http://"), []store.Bookmark{
		{Title: "Example", URL: "https://example.com"},
	}, true)
	if err == nil || !strings.Contains(err.Error(), "outcome is unknown") {
		t.Fatalf("error = %v; want malformed-response unknown outcome", err)
	}
}

func TestDaemonClientDoesNotReplayMutationAcrossRedirect(t *testing.T) {
	redirectedRequests := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		redirectedRequests++
		w.WriteHeader(http.StatusCreated)
	}))
	defer target.Close()

	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirector.Close()

	_, err := postBookmark(
		strings.TrimPrefix(redirector.URL, "http://"),
		store.Bookmark{Title: "Example", URL: "https://example.com"},
	)
	var serverErr *httpServerError
	if !errors.As(err, &serverErr) || serverErr.status != http.StatusTemporaryRedirect {
		t.Fatalf("error = %v; want un-followed 307 server error", err)
	}
	if redirectedRequests != 0 {
		t.Fatalf("redirect target received %d mutation requests; want 0", redirectedRequests)
	}
}

func TestDaemonClientRejectsOversizedSuccessfulResponse(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, strings.Repeat("x", maxAPIResponseBody+1))
	}))
	defer ts.Close()

	_, err := postBookmark(
		strings.TrimPrefix(ts.URL, "http://"),
		store.Bookmark{Title: "Example", URL: "https://example.com"},
	)
	if err == nil || !strings.Contains(err.Error(), "outcome may be unknown") {
		t.Fatalf("error = %v; want oversized unknown-outcome error", err)
	}
}

func TestConnectionRefusedFallbackClassification(t *testing.T) {
	if !isConnectionRefused(errors.Join(errors.New("dial failed"), syscall.ECONNREFUSED)) {
		t.Fatal("wrapped ECONNREFUSED was not classified for direct fallback")
	}
	for name, err := range map[string]error{
		"timeout":          context.DeadlineExceeded,
		"connection reset": syscall.ECONNRESET,
		"short response":   io.ErrUnexpectedEOF,
	} {
		t.Run(name, func(t *testing.T) {
			if isConnectionRefused(err) {
				t.Fatalf("%v was incorrectly classified for direct fallback", err)
			}
		})
	}
}

func TestListenLoopbackRejectsNonLocalAddresses(t *testing.T) {
	for _, addr := range []string{
		"0.0.0.0:8765",
		"[::]:8765",
		"192.0.2.1:8765",
		"example.com:8765",
		"127.0.0.1:",
		"127.0.0.1:http",
	} {
		if err := validateLoopbackAddress(addr); err == nil {
			t.Errorf("validateLoopbackAddress(%q) succeeded; want error", addr)
		}
	}

	ln, err := listenLoopback("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	if err := ln.Close(); err != nil {
		t.Fatal(err)
	}
	if err := validateLoopbackAddress("[::1]:8765"); err != nil {
		t.Fatalf("IPv6 loopback rejected: %v", err)
	}
	if err := validateLoopbackAddress("localhost:8765"); err != nil {
		t.Fatalf("localhost rejected: %v", err)
	}
}

func TestListenLoopbackReportsPortCollisionSynchronously(t *testing.T) {
	owner, err := listenLoopback("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := owner.Close(); err != nil {
			t.Errorf("close listener: %v", err)
		}
	}()
	if second, err := listenLoopback(owner.Addr().String()); err == nil {
		_ = second.Close()
		t.Fatal("second listener unexpectedly acquired an occupied port")
	}
}

func TestRunServeRejectsPublicBindBeforeCreatingStore(t *testing.T) {
	dir := t.TempDir() + "/must-not-exist"
	if code := runServe([]string{"--addr", "0.0.0.0:8765", "--data-dir", dir}); code != 2 {
		t.Fatalf("runServe code = %d; want 2", code)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("invalid public bind created data directory: %v", err)
	}
}

func TestDryRunSnapshotDoesNotCreateDataDirectory(t *testing.T) {
	dir := t.TempDir() + "/missing"
	bookmarks, err := loadBookmarksForDryRun("127.0.0.1:1", dir, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(bookmarks) != 0 {
		t.Fatalf("bookmarks = %+v", bookmarks)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("dry-run created data directory or returned unexpected stat error: %v", err)
	}
}

func closedLoopbackAddress(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	if err := ln.Close(); err != nil {
		t.Fatal(err)
	}
	return addr
}
