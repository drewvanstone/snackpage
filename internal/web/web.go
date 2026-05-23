// Package web exposes the embedded frontend assets.
package web

import "embed"

//go:embed assets
var FS embed.FS
