// Add subcommand: create a bookmark from the CLI.
//
// Strategy: POST to a running daemon first. Only a definitive
// connection-refused error falls back to a locked direct write. A timeout,
// reset, malformed response, or HTTP error may mean the daemon committed the
// request, so retrying directly would risk a duplicate.
package main

import (
	"flag"
	"fmt"
	"net/url"
	"os"
	"strings"

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
	offline := fs.Bool("offline", false, "write directly with an exclusive lock instead of contacting the daemon")
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
	rawURL, parsed, err := normalizeBookmarkURL(rest[0])
	if err != nil {
		fmt.Fprintf(os.Stderr, "snackpage add: %v\n", err)
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

	if !*offline {
		created, postErr := postBookmark(*addr, bm)
		if postErr == nil {
			fmt.Printf("added %s  %s\n", created.ID, created.Title)
			return 0
		}
		if !isConnectionRefused(postErr) {
			fmt.Fprintf(os.Stderr, "snackpage add: daemon request failed; not retrying directly: %v\n", postErr)
			return 1
		}
	}

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
	defer func() {
		if err := st.Close(); err != nil {
			fmt.Fprintln(os.Stderr, "snackpage add: close store:", err)
		}
	}()
	created, err := st.Add(bm)
	if err != nil {
		fmt.Fprintln(os.Stderr, "snackpage add:", err)
		return 1
	}
	if *offline {
		fmt.Printf("added %s  %s  (offline write)\n", created.ID, created.Title)
	} else {
		fmt.Printf("added %s  %s  (direct write — connection refused at %s)\n", created.ID, created.Title, *addr)
	}
	return 0
}

func normalizeBookmarkURL(raw string) (string, *url.URL, error) {
	normalized := strings.TrimSpace(raw)
	if !strings.Contains(normalized, "://") {
		normalized = "https://" + normalized
	}
	parsed, err := url.Parse(normalized)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", nil, fmt.Errorf("%q is not a valid URL (scheme and host required)", raw)
	}
	return normalized, parsed, nil
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
