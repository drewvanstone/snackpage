package server_test

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/drewvanstone/snackpage/internal/server"
	"github.com/drewvanstone/snackpage/internal/store"
)

func newTestServer(t *testing.T) *httptest.Server {
	return newTestServerWith(t, server.Options{})
}

func newTestServerWith(t *testing.T, opts server.Options) *httptest.Server {
	t.Helper()
	return newTestServerAt(t, t.TempDir(), opts)
}

func newTestServerAt(t *testing.T, dir string, opts server.Options) *httptest.Server {
	t.Helper()
	st, err := store.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := st.Close(); err != nil {
			t.Errorf("close store: %v", err)
		}
	})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := server.New(st, logger, opts).Handler()
	return httptest.NewServer(h)
}

func closeResponse(t *testing.T, resp *http.Response) {
	t.Helper()
	if err := resp.Body.Close(); err != nil {
		t.Errorf("close response body: %v", err)
	}
}

func TestHealthz(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer closeResponse(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d; want 200", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if strings.TrimSpace(string(body)) != "ok" {
		t.Errorf("body = %q; want %q", body, "ok")
	}
}

func TestRoot_ServesIndex(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer closeResponse(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d; want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q; want text/html", ct)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "snackpage") {
		t.Errorf("body missing 'snackpage'; got: %s", body)
	}
}

func TestStaticAssets(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	for _, path := range []string{"/static/style.css", "/static/app.js"} {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		closeResponse(t, resp)
		if resp.StatusCode != http.StatusOK {
			t.Errorf("%s: status = %d; want 200", path, resp.StatusCode)
		}
	}
}

func TestStaticAssets_DefaultRevalidates(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/static/theme.js")
	if err != nil {
		t.Fatal(err)
	}
	closeResponse(t, resp)
	if got := resp.Header.Get("Cache-Control"); got != "public, max-age=0, must-revalidate" {
		t.Errorf("Cache-Control = %q; want revalidation", got)
	}
}

// Dev mode must disable caching on every static asset so that `make dev-run`
// + a normal reload picks up freshly-rebuilt theme.js / CSS / images.
func TestStaticAssets_DevModeNoStore(t *testing.T) {
	ts := newTestServerWith(t, server.Options{Dev: true})
	defer ts.Close()

	for _, path := range []string{"/static/theme.js", "/static/style.css", "/static/themes/catppuccin-mocha.css"} {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		closeResponse(t, resp)
		if got := resp.Header.Get("Cache-Control"); got != "no-store" {
			t.Errorf("%s: Cache-Control = %q; want %q", path, got, "no-store")
		}
	}
}

// In dev mode the rendered HTML pages must also be uncached — otherwise the
// browser might keep a stale shell that still references old script URLs.
func TestIndex_DevModeNoStore(t *testing.T) {
	ts := newTestServerWith(t, server.Options{Dev: true})
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	closeResponse(t, resp)
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q; want %q", got, "no-store")
	}
}

func TestHTMLAndAPIAreNeverCached(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	for _, path := range []string{"/", "/manage", "/healthz", "/api/bookmarks"} {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		closeResponse(t, resp)
		if got := resp.Header.Get("Cache-Control"); got != "no-store" {
			t.Errorf("%s: Cache-Control = %q; want no-store", path, got)
		}
	}
}

// When the binary is built with a version stamp, the rendered HTML must
// append ?v=<version> to the entry-point script so a release invalidates
// stale browser-cached JS/CSS.
func TestIndex_VersionStamp(t *testing.T) {
	ts := newTestServerWith(t, server.Options{Version: "v1.2.3"})
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer closeResponse(t, resp)
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `/static/app.js?v=v1.2.3`) {
		t.Errorf("index missing versioned app.js; body:\n%s", body)
	}
}

// Without a version (e.g. `go run` builds where ldflags didn't fire), the
// script src must NOT carry a dangling `?v=` — we'd rather have no query at
// all than an empty one that some caches treat as a distinct resource.
func TestIndex_NoVersionStamp(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer closeResponse(t, resp)
	body, _ := io.ReadAll(resp.Body)
	if strings.Contains(string(body), `app.js?v=`) {
		t.Errorf("index has dangling ?v= with no version set; body:\n%s", body)
	}
	if !strings.Contains(string(body), `/static/app.js"`) {
		t.Errorf("index missing bare app.js script tag; body:\n%s", body)
	}
}

func TestManage_VersionStamp(t *testing.T) {
	ts := newTestServerWith(t, server.Options{Version: "v9.9.9"})
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/manage")
	if err != nil {
		t.Fatal(err)
	}
	defer closeResponse(t, resp)
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `/static/manage.js?v=v9.9.9`) {
		t.Errorf("manage missing versioned manage.js; body:\n%s", body)
	}
}

func TestUnknownRoute(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()
	resp, err := http.Get(ts.URL + "/nope")
	if err != nil {
		t.Fatal(err)
	}
	defer closeResponse(t, resp)
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d; want 404", resp.StatusCode)
	}
}

func TestGetBookmarks_Empty(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/bookmarks")
	if err != nil {
		t.Fatal(err)
	}
	defer closeResponse(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d; want 200", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"bookmarks":[]`) {
		t.Errorf("body = %s", body)
	}
}

func postJSON(t *testing.T, url, body string) (*http.Response, []byte) {
	t.Helper()
	resp, err := http.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer closeResponse(t, resp)
	data, _ := io.ReadAll(resp.Body)
	return resp, data
}

func TestPostBookmark_Creates(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	resp, body := postJSON(t, ts.URL+"/api/bookmarks", `{
		"title":"Team Dashboard",
		"url":"https://example.com",
		"tags":["work"],
		"aliases":["team board"]
	}`)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d; body = %s", resp.StatusCode, body)
	}
	if !strings.Contains(string(body), `"id":"`) {
		t.Errorf("response missing id: %s", body)
	}
}

func TestPostBookmark_RejectsBadURL(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()
	resp, _ := postJSON(t, ts.URL+"/api/bookmarks", `{"title":"x","url":"::::"}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d; want 400", resp.StatusCode)
	}
}

func TestPostBookmark_StrictJSONContract(t *testing.T) {
	tests := []struct {
		name        string
		contentType string
		body        string
		wantStatus  int
	}{
		{
			name:       "missing content type",
			body:       `{"title":"x","url":"https://example.com"}`,
			wantStatus: http.StatusUnsupportedMediaType,
		},
		{
			name:        "unknown field",
			contentType: "application/json",
			body:        `{"title":"x","url":"https://example.com","surprise":true}`,
			wantStatus:  http.StatusBadRequest,
		},
		{
			name:        "trailing value",
			contentType: "application/json",
			body:        `{"title":"x","url":"https://example.com"} {}`,
			wantStatus:  http.StatusBadRequest,
		},
		{
			name:        "oversized",
			contentType: "application/json",
			body:        `{"title":"` + strings.Repeat("x", (1<<20)+1) + `","url":"https://example.com"}`,
			wantStatus:  http.StatusRequestEntityTooLarge,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ts := newTestServer(t)
			defer ts.Close()
			req, err := http.NewRequest(http.MethodPost, ts.URL+"/api/bookmarks", strings.NewReader(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			if tc.contentType != "" {
				req.Header.Set("Content-Type", tc.contentType)
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer closeResponse(t, resp)
			if resp.StatusCode != tc.wantStatus {
				body, _ := io.ReadAll(resp.Body)
				t.Fatalf("status = %d; want %d; body = %s", resp.StatusCode, tc.wantStatus, body)
			}
		})
	}
}

func TestPostBookmarkBatch_IsAtomicAndDeduplicates(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	resp, body := postJSON(t, ts.URL+"/api/bookmarks/batch", `{
		"bookmarks":[
			{"title":"one","url":"one.example"},
			{"title":"one again","url":"https://one.example"},
			{"title":"two","url":"https://two.example"}
		],
		"skip_existing_urls":true
	}`)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d; body = %s", resp.StatusCode, body)
	}
	var result struct {
		Created         []store.Bookmark `json:"created"`
		SkippedExisting int              `json:"skipped_existing"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Created) != 2 || result.SkippedExisting != 1 {
		t.Fatalf("result = %+v; want 2 created and 1 skipped", result)
	}

	resp, body = postJSON(t, ts.URL+"/api/bookmarks/batch", `{
		"bookmarks":[
			{"title":"valid","url":"https://valid.example"},
			{"title":"","url":"https://invalid.example"}
		],
		"skip_existing_urls":true
	}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid batch status = %d; body = %s", resp.StatusCode, body)
	}
	listResp, err := http.Get(ts.URL + "/api/bookmarks")
	if err != nil {
		t.Fatal(err)
	}
	defer closeResponse(t, listResp)
	var list struct {
		Bookmarks []store.Bookmark `json:"bookmarks"`
	}
	if err := json.NewDecoder(listResp.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list.Bookmarks) != 2 {
		t.Fatalf("invalid batch partially committed: %+v", list.Bookmarks)
	}
}

func TestExternalBookmarkChangeReturnsConflict(t *testing.T) {
	dir := t.TempDir()
	ts := newTestServerAt(t, dir, server.Options{})
	defer ts.Close()

	path := filepath.Join(dir, "bookmarks.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	resp, body := postJSON(t, ts.URL+"/api/bookmarks", `{"title":"x","url":"https://example.com"}`)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d; want 409; body = %s", resp.StatusCode, body)
	}
}

func TestPutBookmark_Updates(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()
	_, body := postJSON(t, ts.URL+"/api/bookmarks", `{"title":"a","url":"https://example.com"}`)
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(body, &created)

	req, err := http.NewRequest("PUT", ts.URL+"/api/bookmarks/"+created.ID,
		strings.NewReader(`{"title":"b","url":"https://example.com/v2"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer closeResponse(t, resp)
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d", resp.StatusCode)
	}
}

func TestDeleteBookmark(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()
	_, body := postJSON(t, ts.URL+"/api/bookmarks", `{"title":"a","url":"https://example.com"}`)
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(body, &created)

	req, err := http.NewRequest("DELETE", ts.URL+"/api/bookmarks/"+created.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer closeResponse(t, resp)
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("status = %d; want 204", resp.StatusCode)
	}
}

func TestDeleteBookmark_NotFound(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()
	req, err := http.NewRequest("DELETE", ts.URL+"/api/bookmarks/00000000", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer closeResponse(t, resp)
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d; want 404", resp.StatusCode)
	}
}

func TestRedirect_BumpsStatsAndRedirects(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	_, body := postJSON(t, ts.URL+"/api/bookmarks", `{"title":"X","url":"https://example.com/x"}`)
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(body, &created)

	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Get(ts.URL + "/go/" + created.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer closeResponse(t, resp)
	if resp.StatusCode != http.StatusFound {
		t.Errorf("status = %d; want 302", resp.StatusCode)
	}
	if loc := resp.Header.Get("Location"); loc != "https://example.com/x" {
		t.Errorf("Location = %q; want %q", loc, "https://example.com/x")
	}
	if got := resp.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q; want no-store", got)
	}

	// Verify GET /api/bookmarks now shows visit_count: 1
	listResp, err := http.Get(ts.URL + "/api/bookmarks")
	if err != nil {
		t.Fatal(err)
	}
	defer closeResponse(t, listResp)
	listBody, _ := io.ReadAll(listResp.Body)
	if !strings.Contains(string(listBody), `"visit_count":1`) {
		t.Errorf("expected visit_count=1; got %s", listBody)
	}
	if !strings.Contains(string(listBody), `"frecency_score":`) {
		t.Errorf("expected server-computed frecency_score; got %s", listBody)
	}
}

func TestRedirect_HEADDoesNotBumpStats(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	_, body := postJSON(t, ts.URL+"/api/bookmarks", `{"title":"X","url":"https://example.com/x"}`)
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(body, &created); err != nil {
		t.Fatal(err)
	}

	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	req, err := http.NewRequest(http.MethodHead, ts.URL+"/go/"+created.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	closeResponse(t, resp)
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("status = %d; want 302", resp.StatusCode)
	}

	listResp, err := http.Get(ts.URL + "/api/bookmarks")
	if err != nil {
		t.Fatal(err)
	}
	defer closeResponse(t, listResp)
	listBody, _ := io.ReadAll(listResp.Body)
	if !strings.Contains(string(listBody), `"visit_count":0`) {
		t.Errorf("HEAD changed visit stats: %s", listBody)
	}
}

func TestRedirect_NotFound(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()
	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Get(ts.URL + "/go/00000000")
	if err != nil {
		t.Fatal(err)
	}
	defer closeResponse(t, resp)
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d; want 404", resp.StatusCode)
	}
}

func TestSecurityHeadersAndLocalRequestChecks(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	closeResponse(t, resp)
	csp := resp.Header.Get("Content-Security-Policy")
	if csp == "" || strings.Contains(csp, "unsafe-inline") {
		t.Fatalf("unexpected CSP %q", csp)
	}
	if got := resp.Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q", got)
	}

	badHost, err := http.NewRequest(http.MethodGet, ts.URL+"/healthz", nil)
	if err != nil {
		t.Fatal(err)
	}
	badHost.Host = "attacker.example"
	resp, err = http.DefaultClient.Do(badHost)
	if err != nil {
		t.Fatal(err)
	}
	closeResponse(t, resp)
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("bad Host status = %d; want 400", resp.StatusCode)
	}

	crossOrigin, err := http.NewRequest(http.MethodPost, ts.URL+"/api/bookmarks",
		strings.NewReader(`{"title":"x","url":"https://example.com"}`))
	if err != nil {
		t.Fatal(err)
	}
	crossOrigin.Header.Set("Content-Type", "application/json")
	crossOrigin.Header.Set("Origin", "https://attacker.example")
	resp, err = http.DefaultClient.Do(crossOrigin)
	if err != nil {
		t.Fatal(err)
	}
	closeResponse(t, resp)
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("cross-origin status = %d; want 403", resp.StatusCode)
	}

	wrongScheme, err := http.NewRequest(http.MethodPost, ts.URL+"/api/bookmarks",
		strings.NewReader(`{"title":"x","url":"https://example.com"}`))
	if err != nil {
		t.Fatal(err)
	}
	wrongScheme.Header.Set("Content-Type", "application/json")
	wrongScheme.Header.Set("Origin", strings.Replace(ts.URL, "http://", "https://", 1))
	resp, err = http.DefaultClient.Do(wrongScheme)
	if err != nil {
		t.Fatal(err)
	}
	closeResponse(t, resp)
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("cross-scheme status = %d; want 403", resp.StatusCode)
	}
}
