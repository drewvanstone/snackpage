package server_test

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/drewvanstone/snackpage/internal/server"
	"github.com/drewvanstone/snackpage/internal/store"
)

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	st, err := store.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := server.New(st, logger).Handler()
	return httptest.NewServer(h)
}

func TestHealthz(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
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
	defer resp.Body.Close()
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
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("%s: status = %d; want 200", path, resp.StatusCode)
		}
	}
}

func TestUnknownRoute(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()
	resp, _ := http.Get(ts.URL + "/nope")
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
	defer resp.Body.Close()
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
	defer resp.Body.Close()
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

func TestPutBookmark_Updates(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()
	resp, body := postJSON(t, ts.URL+"/api/bookmarks", `{"title":"a","url":"https://example.com"}`)
	var created struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(body, &created)

	req, _ := http.NewRequest("PUT", ts.URL+"/api/bookmarks/"+created.ID,
		strings.NewReader(`{"title":"b","url":"https://example.com/v2"}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
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

	req, _ := http.NewRequest("DELETE", ts.URL+"/api/bookmarks/"+created.ID, nil)
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("status = %d; want 204", resp.StatusCode)
	}
}

func TestDeleteBookmark_NotFound(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()
	req, _ := http.NewRequest("DELETE", ts.URL+"/api/bookmarks/00000000", nil)
	resp, _ := http.DefaultClient.Do(req)
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
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Errorf("status = %d; want 302", resp.StatusCode)
	}
	if loc := resp.Header.Get("Location"); loc != "https://example.com/x" {
		t.Errorf("Location = %q; want %q", loc, "https://example.com/x")
	}

	// Verify GET /api/bookmarks now shows visit_count: 1
	listResp, err := http.Get(ts.URL + "/api/bookmarks")
	if err != nil {
		t.Fatal(err)
	}
	defer listResp.Body.Close()
	listBody, _ := io.ReadAll(listResp.Body)
	if !strings.Contains(string(listBody), `"visit_count":1`) {
		t.Errorf("expected visit_count=1; got %s", listBody)
	}
}

func TestRedirect_NotFound(t *testing.T) {
	ts := newTestServer(t)
	defer ts.Close()
	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, _ := client.Get(ts.URL + "/go/00000000")
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d; want 404", resp.StatusCode)
	}
}
