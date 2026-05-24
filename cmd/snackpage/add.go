// Add subcommand: create a bookmark from the CLI.
//
// Strategy: try POST to a running daemon first (500ms timeout). If the
// transport fails (no listener, timeout, DNS, etc.), fall back to a direct
// store.Add() write. If the daemon answered with a non-2xx (e.g. 400
// validation), surface that error and exit 1 — do not fall back, since the
// server already saw and rejected the input.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/drewvanstone/snackpage/internal/store"
	"github.com/drewvanstone/snackpage/internal/xdg"
)

func runAdd(args []string) int {
	fs := flag.NewFlagSet("add", flag.ExitOnError)
	title := fs.String("title", "", "bookmark title (default: URL hostname)")
	tagsCSV := fs.String("tags", "", "comma-separated tags")
	aliasesCSV := fs.String("aliases", "", "comma-separated aliases")
	addr := fs.String("addr", "127.0.0.1:8765", "snackpage daemon address")
	dataDir := fs.String("data-dir", "", "direct-write data dir (overrides XDG)")
	// Reorder so positional args (the URL) can appear anywhere relative to flags.
	// Stock Go flag parsing stops at the first non-flag token; users typically
	// type `snackpage add https://example.com --title X`, so accept either order.
	flagArgs, positionals := splitFlagsAndPositionals(args)
	_ = fs.Parse(flagArgs)

	rest := append(positionals, fs.Args()...)
	if len(rest) != 1 {
		fmt.Fprintln(os.Stderr, "snackpage add: exactly one URL argument is required")
		fmt.Fprintln(os.Stderr, "usage: snackpage add URL [flags]")
		return 2
	}
	rawURL := rest[0]

	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		fmt.Fprintf(os.Stderr, "snackpage add: %q is not a valid URL (scheme and host required)\n", rawURL)
		return 2
	}

	titleVal := strings.TrimSpace(*title)
	if titleVal == "" {
		titleVal = parsed.Host
	}

	bm := store.Bookmark{
		Title:   titleVal,
		URL:     rawURL,
		Tags:    splitCSV(*tagsCSV),
		Aliases: splitCSV(*aliasesCSV),
	}

	// Try POST first.
	created, postErr := postBookmark(*addr, bm)
	if postErr == nil {
		fmt.Printf("added %s  %s\n", created.ID, created.Title)
		return 0
	}
	// If the daemon answered with a non-2xx, surface and exit. Only fall back
	// when the daemon could not be reached at all.
	var serverErr *httpServerError
	if errors.As(postErr, &serverErr) {
		fmt.Fprintf(os.Stderr, "snackpage add: server rejected: %s\n", serverErr.body)
		return 1
	}

	// Fall back to direct write for any transport error (refused, timeout, DNS, etc.).
	dir := *dataDir
	if dir == "" {
		dir, err = xdg.DataDir("snackpage")
		if err != nil {
			fmt.Fprintln(os.Stderr, "snackpage add:", err)
			return 1
		}
	}
	st, err := store.New(dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "snackpage add:", err)
		return 1
	}
	created, err = st.Add(bm)
	if err != nil {
		fmt.Fprintln(os.Stderr, "snackpage add:", err)
		return 1
	}
	fmt.Printf("added %s  %s  (direct write — no daemon at %s)\n", created.ID, created.Title, *addr)
	return 0
}

// httpServerError marks a non-2xx response from the daemon. It is the only
// error type from postBookmark that should NOT trigger fallback — the server
// saw the request and chose to reject it.
type httpServerError struct {
	status int
	body   string
}

func (e *httpServerError) Error() string {
	return fmt.Sprintf("server returned %d: %s", e.status, e.body)
}

// postBookmark POSTs the bookmark to a running daemon.
//
// Returns:
//   - (created, nil) on 2xx
//   - (_, *httpServerError) on non-2xx (daemon answered but rejected)
//   - (_, transport error) when the daemon could not be reached
func postBookmark(addr string, bm store.Bookmark) (store.Bookmark, error) {
	body, err := json.Marshal(struct {
		Title   string   `json:"title"`
		URL     string   `json:"url"`
		Tags    []string `json:"tags"`
		Aliases []string `json:"aliases"`
	}{bm.Title, bm.URL, bm.Tags, bm.Aliases})
	if err != nil {
		return store.Bookmark{}, err
	}

	client := &http.Client{Timeout: 500 * time.Millisecond}
	resp, err := client.Post("http://"+addr+"/api/bookmarks", "application/json", bytes.NewReader(body))
	if err != nil {
		// Any transport-level error means "no daemon reachable" — surface to caller for fallback.
		return store.Bookmark{}, err
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		return store.Bookmark{}, &httpServerError{
			status: resp.StatusCode,
			body:   strings.TrimSpace(string(respBody)),
		}
	}
	var created store.Bookmark
	if err := json.Unmarshal(respBody, &created); err != nil {
		return store.Bookmark{}, err
	}
	return created, nil
}

// splitFlagsAndPositionals walks args once and partitions tokens into
// flag-related tokens (preserving order) and positionals. Recognizes
//
//	-flag, --flag        boolean / shorthand
//	-flag=v, --flag=v    inline value
//	-flag v, --flag v    space-separated value (must consume next token)
//
// The "--" sentinel stops flag processing — everything after is positional.
// All `add` flags take string values; none are booleans.
func splitFlagsAndPositionals(args []string) (flags, positionals []string) {
	stringFlags := map[string]bool{
		"title":    true,
		"tags":     true,
		"aliases":  true,
		"addr":     true,
		"data-dir": true,
	}
	endOfFlags := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		if endOfFlags {
			positionals = append(positionals, a)
			continue
		}
		if a == "--" {
			endOfFlags = true
			flags = append(flags, a)
			continue
		}
		if !strings.HasPrefix(a, "-") || a == "-" {
			positionals = append(positionals, a)
			continue
		}
		// Strip leading dashes to get the name.
		name := strings.TrimLeft(a, "-")
		// Inline value form (--flag=value): always a flag, no extra token.
		if eq := strings.IndexByte(name, '='); eq >= 0 {
			flags = append(flags, a)
			continue
		}
		flags = append(flags, a)
		// Space-separated value form: consume next token if this is a known string flag.
		if stringFlags[name] && i+1 < len(args) {
			flags = append(flags, args[i+1])
			i++
		}
	}
	return flags, positionals
}

// splitCSV splits a comma-separated string into a trimmed slice, dropping empties.
func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
