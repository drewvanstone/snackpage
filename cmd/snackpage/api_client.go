package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"syscall"
	"time"

	"github.com/drewvanstone/snackpage/internal/store"
)

const maxAPIResponseBody = 2 << 20

var daemonHTTPClient = &http.Client{
	Timeout: 3 * time.Second,
	// A 307/308 preserves the method and body. Following one could replay a
	// bookmark mutation to a host that never passed validateLoopbackAddress.
	// The daemon API has no redirect contract, so surface every 3xx response
	// as a definitive server error instead.
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// httpServerError means the daemon definitely answered. Callers must never
// retry such a request as a direct disk write.
type httpServerError struct {
	status int
	body   string
}

func (e *httpServerError) Error() string {
	return fmt.Sprintf("server returned %d: %s", e.status, e.body)
}

func postBookmark(addr string, bm store.Bookmark) (store.Bookmark, error) {
	var created store.Bookmark
	if err := doDaemonJSON(addr, http.MethodPost, "/api/bookmarks", newBookmarkPayload(bm), &created); err != nil {
		return store.Bookmark{}, err
	}
	if created.ID == "" {
		return store.Bookmark{}, errors.New("daemon returned a successful but malformed response; bookmark outcome is unknown")
	}
	return created, nil
}

type batchResponse struct {
	Created         []store.Bookmark `json:"created"`
	SkippedExisting int              `json:"skipped_existing"`
}

func postBookmarkBatch(addr string, bookmarks []store.Bookmark, skipExisting bool) (batchResponse, error) {
	payloads := make([]bookmarkPayload, len(bookmarks))
	for i := range bookmarks {
		payloads[i] = newBookmarkPayload(bookmarks[i])
	}
	body := struct {
		Bookmarks        []bookmarkPayload `json:"bookmarks"`
		SkipExistingURLs bool              `json:"skip_existing_urls"`
	}{
		Bookmarks:        payloads,
		SkipExistingURLs: skipExisting,
	}
	var result batchResponse
	if err := doDaemonJSON(addr, http.MethodPost, "/api/bookmarks/batch", body, &result); err != nil {
		return batchResponse{}, err
	}
	if result.Created == nil || result.SkippedExisting < 0 ||
		len(result.Created)+result.SkippedExisting != len(bookmarks) {
		return batchResponse{}, errors.New("daemon returned a successful but malformed response; import outcome is unknown")
	}
	for _, bm := range result.Created {
		if bm.ID == "" {
			return batchResponse{}, errors.New("daemon returned a successful but malformed response; import outcome is unknown")
		}
	}
	return result, nil
}

func getBookmarks(addr string) ([]store.Bookmark, error) {
	var result struct {
		Bookmarks []store.Bookmark `json:"bookmarks"`
	}
	if err := doDaemonJSON(addr, http.MethodGet, "/api/bookmarks", nil, &result); err != nil {
		return nil, err
	}
	if result.Bookmarks == nil {
		return nil, errors.New("daemon returned a successful but malformed bookmark list")
	}
	return result.Bookmarks, nil
}

type bookmarkPayload struct {
	Title   string   `json:"title"`
	URL     string   `json:"url"`
	Tags    []string `json:"tags"`
	Aliases []string `json:"aliases"`
}

func newBookmarkPayload(bm store.Bookmark) bookmarkPayload {
	return bookmarkPayload{
		Title: bm.Title, URL: bm.URL, Tags: bm.Tags, Aliases: bm.Aliases,
	}
}

func doDaemonJSON(addr, method, path string, requestBody, responseBody any) error {
	if err := validateLoopbackAddress(addr); err != nil {
		return err
	}
	var encoded []byte
	var err error
	if requestBody != nil {
		encoded, err = json.Marshal(requestBody)
		if err != nil {
			return err
		}
	}
	req, err := http.NewRequest(method, "http://"+addr+path, bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	if requestBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")

	resp, err := daemonHTTPClient.Do(req)
	if err != nil {
		return err
	}

	limited := io.LimitReader(resp.Body, maxAPIResponseBody+1)
	data, err := io.ReadAll(limited)
	closeErr := resp.Body.Close()
	if err != nil {
		return fmt.Errorf("read daemon response (bookmark outcome may be unknown): %w", err)
	}
	if closeErr != nil {
		return fmt.Errorf("close daemon response (bookmark outcome may be unknown): %w", closeErr)
	}
	if len(data) > maxAPIResponseBody {
		return errors.New("daemon response was too large; bookmark outcome may be unknown")
	}
	if resp.StatusCode/100 != 2 {
		return &httpServerError{
			status: resp.StatusCode,
			body:   daemonErrorMessage(data),
		}
	}
	if err := json.Unmarshal(data, responseBody); err != nil {
		return fmt.Errorf("decode successful daemon response (bookmark outcome may be unknown): %w", err)
	}
	return nil
}

func daemonErrorMessage(data []byte) string {
	var body struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(data, &body) == nil && body.Error != "" {
		return body.Error
	}
	if text := strings.TrimSpace(string(data)); text != "" {
		return text
	}
	return "request failed"
}

func isConnectionRefused(err error) bool {
	return errors.Is(err, syscall.ECONNREFUSED)
}
