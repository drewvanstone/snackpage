// Command snackpage import imports bookmarks from external sources.
package main

import (
	"fmt"
	"os"
)

func runImport(args []string) int {
	if len(args) < 1 {
		fmt.Fprintln(os.Stderr, "snackpage import: source required (currently only 'chrome' is supported)")
		fmt.Fprintln(os.Stderr, "usage: snackpage import chrome [flags]")
		return 2
	}
	source, rest := args[0], args[1:]
	switch source {
	case "chrome":
		return runImportChrome(rest)
	default:
		fmt.Fprintf(os.Stderr, "snackpage import: unknown source %q (try 'chrome')\n", source)
		return 2
	}
}
