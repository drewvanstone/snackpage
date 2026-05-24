// Command snackpage serves a keyboard-driven bookmark picker on localhost.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/drewvanstone/snackpage/internal/server"
	"github.com/drewvanstone/snackpage/internal/store"
	"github.com/drewvanstone/snackpage/internal/xdg"
)

// Injected at build time via -ldflags.
var version = "dev"

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(2)
	}
	sub, args := os.Args[1], os.Args[2:]
	switch sub {
	case "serve":
		os.Exit(runServe(args))
	case "demo":
		os.Exit(runDemo(args))
	case "add":
		os.Exit(runAdd(args))
	case "version", "--version", "-v":
		fmt.Println("snackpage", version)
	case "help", "--help", "-h":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "snackpage: unknown subcommand %q\n", sub)
		printUsage()
		os.Exit(2)
	}
}

func printUsage() {
	fmt.Fprintln(os.Stderr, `Usage:
  snackpage serve [--addr 127.0.0.1:8765] [--data-dir PATH] [--log-level info]
  snackpage demo  [--addr 127.0.0.1:8765] [--log-level info]
  snackpage add URL [--title T] [--tags t1,t2] [--aliases a1,a2] [--addr 127.0.0.1:8765] [--data-dir PATH]
  snackpage version
  snackpage help`)
}

func runServe(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", "127.0.0.1:8765", "address to listen on (loopback recommended)")
	dataDir := fs.String("data-dir", "", "override XDG data dir")
	logLevel := fs.String("log-level", "info", "debug|info|warn|error")
	_ = fs.Parse(args)

	level, err := parseLevel(*logLevel)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	dir := *dataDir
	if dir == "" {
		dir, err = xdg.DataDir("snackpage")
		if err != nil {
			logger.Error("data_dir_resolve_failed", "err", err)
			return 1
		}
	}
	st, err := store.New(dir)
	if err != nil {
		logger.Error("store_open_failed", "err", err)
		return 1
	}

	srv := &http.Server{
		Addr:              *addr,
		Handler:           server.New(st, logger).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		logger.Info("listening", "addr", *addr, "data_dir", dir)
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

func parseLevel(s string) (slog.Leveler, error) {
	switch s {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return nil, fmt.Errorf("unknown log level %q", s)
	}
}
