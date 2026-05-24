package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/drewvanstone/snackpage/internal/store"
	"github.com/drewvanstone/snackpage/internal/xdg"
)

// Chrome Bookmarks JSON shape (subset).
type chromeNode struct {
	Type     string        `json:"type"`
	Name     string        `json:"name"`
	URL      string        `json:"url,omitempty"`
	Children []*chromeNode `json:"children,omitempty"`
}

type chromeRoots struct {
	BookmarkBar *chromeNode `json:"bookmark_bar"`
	Other       *chromeNode `json:"other"`
	Synced      *chromeNode `json:"synced"`
}

type chromeFile struct {
	Roots chromeRoots `json:"roots"`
}

type chromeCandidate struct {
	Title  string
	URL    string
	Parent string // immediate parent folder name (raw, not lowercased)
}

func runImportChrome(args []string) int {
	fs := flag.NewFlagSet("import chrome", flag.ExitOnError)
	profile := fs.String("profile", "Default", "Chrome profile name")
	path := fs.String("path", "", "explicit path to a Chrome Bookmarks file (overrides --profile)")
	dataDir := fs.String("data-dir", "", "snackpage data dir (overrides XDG)")
	folder := fs.String("folder", "", "limit import to this folder path (e.g., \"Bookmarks bar/Dev\")")
	dryRun := fs.Bool("dry-run", false, "parse and report without writing")
	_ = fs.Parse(args)

	// Resolve bookmarks file path
	bookmarksPath := *path
	if bookmarksPath == "" {
		p, err := chromeBookmarksPath(*profile)
		if err != nil {
			fmt.Fprintln(os.Stderr, "snackpage import chrome:", err)
			return 1
		}
		bookmarksPath = p
	}

	// Read + parse
	data, err := os.ReadFile(bookmarksPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "snackpage import chrome: cannot read %s: %v\n", bookmarksPath, err)
		return 1
	}
	var cf chromeFile
	if err := json.Unmarshal(data, &cf); err != nil {
		fmt.Fprintf(os.Stderr, "snackpage import chrome: cannot parse %s: %v\n", bookmarksPath, err)
		return 1
	}

	// Determine subtree(s) to walk
	candidates, err := collectCandidates(&cf, *folder)
	if err != nil {
		fmt.Fprintln(os.Stderr, "snackpage import chrome:", err)
		return 1
	}

	fmt.Fprintf(os.Stdout, "Parsed %d bookmarks from %s\n", len(candidates), bookmarksPath)

	// Open store and dedupe
	dir := *dataDir
	if dir == "" {
		dir, err = xdg.DataDir("snackpage")
		if err != nil {
			fmt.Fprintln(os.Stderr, "snackpage import chrome:", err)
			return 1
		}
	}
	st, err := store.New(dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "snackpage import chrome:", err)
		return 1
	}
	existing := map[string]bool{}
	bms, _ := st.List()
	for _, b := range bms {
		existing[b.URL] = true
	}

	toImport := make([]chromeCandidate, 0, len(candidates))
	skipped := 0
	for _, c := range candidates {
		if c.URL == "" || c.Title == "" {
			continue // Chrome occasionally has weird entries
		}
		if existing[c.URL] {
			skipped++
			continue
		}
		toImport = append(toImport, c)
	}

	if *dryRun {
		fmt.Fprintf(os.Stdout, "Would import %d new bookmarks (%d already exist)\n", len(toImport), skipped)
		return 0
	}

	imported := 0
	for _, c := range toImport {
		_, err := st.Add(store.Bookmark{
			Title: c.Title,
			URL:   c.URL,
			Tags:  []string{strings.ToLower(c.Parent)},
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "snackpage import chrome: skipping %q (%s): %v\n", c.Title, c.URL, err)
			continue
		}
		imported++
	}
	fmt.Fprintf(os.Stdout, "Imported %d new bookmarks (%d already existed, skipped)\n", imported, skipped)
	return 0
}

// chromeBookmarksPath returns the OS-specific Chrome Bookmarks file path
// for the given profile.
func chromeBookmarksPath(profile string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Google", "Chrome", profile, "Bookmarks"), nil
	case "linux":
		return filepath.Join(home, ".config", "google-chrome", profile, "Bookmarks"), nil
	default:
		return "", fmt.Errorf("unsupported OS %q (use --path to point at the Bookmarks file directly)", runtime.GOOS)
	}
}

// collectCandidates walks the bookmarks tree and returns all URL entries,
// either everything (folderPath == "") or only those under folderPath.
func collectCandidates(cf *chromeFile, folderPath string) ([]chromeCandidate, error) {
	if folderPath == "" {
		// Walk all three roots
		var out []chromeCandidate
		for _, root := range []*chromeNode{cf.Roots.BookmarkBar, cf.Roots.Other, cf.Roots.Synced} {
			if root == nil {
				continue
			}
			walkChrome(root, root.Name, &out)
		}
		return out, nil
	}
	// Navigate to the requested folder
	sub, err := navigateToFolder(cf, folderPath)
	if err != nil {
		return nil, err
	}
	var out []chromeCandidate
	walkChrome(sub, sub.Name, &out)
	return out, nil
}

func walkChrome(node *chromeNode, parentName string, out *[]chromeCandidate) {
	if node == nil {
		return
	}
	if node.Type == "url" {
		*out = append(*out, chromeCandidate{
			Title:  node.Name,
			URL:    node.URL,
			Parent: parentName,
		})
		return
	}
	// folder: parent for children is THIS node's name
	for _, c := range node.Children {
		walkChrome(c, node.Name, out)
	}
}

// navigateToFolder traverses the bookmarks tree to a slash-separated folder path.
// First segment must match one of "Bookmarks bar" / "Other bookmarks" / "Mobile bookmarks"
// (case-insensitive).
func navigateToFolder(cf *chromeFile, folderPath string) (*chromeNode, error) {
	parts := strings.Split(strings.TrimPrefix(folderPath, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		return nil, errors.New("empty folder path")
	}
	var root *chromeNode
	switch strings.ToLower(parts[0]) {
	case "bookmarks bar", "bookmark bar", "bookmark_bar":
		root = cf.Roots.BookmarkBar
	case "other bookmarks", "other":
		root = cf.Roots.Other
	case "mobile bookmarks", "synced", "mobile":
		root = cf.Roots.Synced
	default:
		return nil, fmt.Errorf("unknown root folder %q (try \"Bookmarks bar\", \"Other bookmarks\", or \"Mobile bookmarks\")", parts[0])
	}
	if root == nil {
		return nil, fmt.Errorf("root folder %q is empty in this Bookmarks file", parts[0])
	}
	current := root
	for _, p := range parts[1:] {
		next := findChildByName(current, p)
		if next == nil {
			return nil, fmt.Errorf("folder %q not found under %q", p, current.Name)
		}
		if next.Type != "folder" {
			return nil, fmt.Errorf("%q is not a folder", p)
		}
		current = next
	}
	return current, nil
}

func findChildByName(folder *chromeNode, name string) *chromeNode {
	for _, c := range folder.Children {
		if strings.EqualFold(c.Name, name) {
			return c
		}
	}
	return nil
}
