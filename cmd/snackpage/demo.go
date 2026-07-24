// Demo mode: seeds 100 generic bookmarks into an ephemeral tempdir and serves
// like `serve`. The tempdir is removed on shutdown — never touches the user's
// real data directory.
package main

import (
	"flag"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"os"
	"time"

	"github.com/drewvanstone/snackpage/internal/server"
	"github.com/drewvanstone/snackpage/internal/store"
)

type demoEntry struct {
	Title   string
	URL     string
	Tags    []string
	Aliases []string
}

func runDemo(args []string) int {
	fs := flag.NewFlagSet("demo", flag.ExitOnError)
	addr := fs.String("addr", "127.0.0.1:8765", "address to listen on")
	logLevel := fs.String("log-level", "info", "debug|info|warn|error")
	dev := fs.Bool("dev", false, "dev mode: disable static-asset caching")
	_ = fs.Parse(args)

	level, err := parseLevel(*logLevel)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	if err := validateLoopbackAddress(*addr); err != nil {
		logger.Error("invalid_listen_address", "addr", *addr, "err", err)
		return 2
	}

	dir, err := os.MkdirTemp("", "snackpage-demo-*")
	if err != nil {
		logger.Error("tempdir_failed", "err", err)
		return 1
	}
	defer func() {
		if err := os.RemoveAll(dir); err != nil {
			logger.Error("tempdir_cleanup_failed", "path", dir, "err", err)
		}
	}()
	logger.Info("demo_data_dir", "path", dir)

	st, err := store.New(dir)
	if err != nil {
		logger.Error("store_open_failed", "err", err)
		return 1
	}
	defer func() {
		if err := st.Close(); err != nil {
			logger.Error("store_close_failed", "err", err)
		}
	}()

	if err := seedDemo(st); err != nil {
		logger.Error("seed_failed", "err", err)
		return 1
	}
	logger.Info("seeded_bookmarks", "count", len(demoData))

	srv := &http.Server{
		Addr:              *addr,
		Handler:           server.New(st, logger, server.Options{Dev: *dev, Version: version}).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}

	ln, err := listenLoopback(*addr)
	if err != nil {
		logger.Error("listen_failed", "addr", *addr, "err", err)
		return 1
	}
	logger.Info("listening", "addr", ln.Addr().String(), "mode", "demo")
	return serveUntilSignal(srv, ln, logger)
}

// seedDemo adds the demo bookmarks and assigns a deterministic pseudo-random
// visit history so the frecency-sorted list looks plausibly "lived in."
// Seed is fixed (42) so each run produces the same arrangement.
func seedDemo(s *store.Store) error {
	rng := rand.New(rand.NewSource(42))
	now := time.Now().UTC()
	for _, d := range demoData {
		bm, err := s.Add(store.Bookmark{
			Title:   d.Title,
			URL:     d.URL,
			Tags:    d.Tags,
			Aliases: d.Aliases,
		})
		if err != nil {
			return fmt.Errorf("add %q: %w", d.Title, err)
		}
		roll := rng.Float64()
		var visits, daysAgo int
		switch {
		case roll < 0.10:
			// Frequent (10%): 30-80 visits in last week
			visits = 30 + rng.Intn(51)
			daysAgo = 1 + rng.Intn(7)
		case roll < 0.30:
			// Regular (20%): 10-29 visits, last 5-20 days
			visits = 10 + rng.Intn(20)
			daysAgo = 5 + rng.Intn(16)
		case roll < 0.55:
			// Occasional (25%): 2-9 visits, last 14-59 days
			visits = 2 + rng.Intn(8)
			daysAgo = 14 + rng.Intn(46)
		case roll < 0.80:
			// Rare (25%): 1-3 visits, last 30-89 days
			visits = 1 + rng.Intn(3)
			daysAgo = 30 + rng.Intn(60)
		default:
			// Never visited (20%)
			visits = 0
		}
		if visits > 0 {
			when := now.AddDate(0, 0, -daysAgo)
			for i := 0; i < visits; i++ {
				if err := s.Visit(bm.ID, when); err != nil {
					return fmt.Errorf("visit %q: %w", d.Title, err)
				}
			}
		}
	}
	return nil
}
