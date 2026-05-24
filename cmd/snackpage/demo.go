// Demo mode: seeds 100 generic bookmarks into an ephemeral tempdir and serves
// like `serve`. The tempdir is removed on shutdown — never touches the user's
// real data directory.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"syscall"
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
	_ = fs.Parse(args)

	level, err := parseLevel(*logLevel)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	dir, err := os.MkdirTemp("", "snackpage-demo-*")
	if err != nil {
		logger.Error("tempdir_failed", "err", err)
		return 1
	}
	defer os.RemoveAll(dir)
	logger.Info("demo_data_dir", "path", dir)

	st, err := store.New(dir)
	if err != nil {
		logger.Error("store_open_failed", "err", err)
		return 1
	}

	if err := seedDemo(st); err != nil {
		logger.Error("seed_failed", "err", err)
		return 1
	}
	logger.Info("seeded_bookmarks", "count", len(demoData))

	srv := &http.Server{
		Addr:              *addr,
		Handler:           server.New(st, logger).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		logger.Info("listening", "addr", *addr, "mode", "demo")
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server_failed", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	logger.Info("shutting_down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("shutdown_failed", "err", err)
		return 1
	}
	return 0
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
