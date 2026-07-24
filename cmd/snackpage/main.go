// Command snackpage serves a keyboard-driven bookmark picker on localhost.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
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
	case "import":
		os.Exit(runImport(args))
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
  snackpage serve [--addr 127.0.0.1:8765] [--data-dir PATH] [--log-level info] [--dev]
  snackpage demo  [--addr 127.0.0.1:8765] [--log-level info] [--dev]
  snackpage add URL [--title T] [--tags t1,t2] [--aliases a1,a2] [--addr 127.0.0.1:8765] [--data-dir PATH] [--offline]
  snackpage import chrome [--profile Default] [--path FILE] [--addr 127.0.0.1:8765] [--data-dir PATH] [--folder "Bookmarks bar/Dev"] [--dry-run] [--offline]
  snackpage version
  snackpage help`)
}

func runServe(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", "127.0.0.1:8765", "loopback address to listen on")
	dataDir := fs.String("data-dir", "", "override XDG data dir")
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
	defer func() {
		if err := st.Close(); err != nil {
			logger.Error("store_close_failed", "err", err)
		}
	}()

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
	logger.Info("listening", "addr", ln.Addr().String(), "data_dir", dir)
	return serveUntilSignal(srv, ln, logger)
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

func listenLoopback(addr string) (net.Listener, error) {
	if err := validateLoopbackAddress(addr); err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	if tcpAddr, ok := ln.Addr().(*net.TCPAddr); ok && !tcpAddr.IP.IsLoopback() {
		_ = ln.Close()
		return nil, fmt.Errorf("resolved listen address %q is not loopback", tcpAddr)
	}
	return ln, nil
}

func validateLoopbackAddress(addr string) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("invalid address %q: %w", addr, err)
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 0 || portNumber > 65535 {
		return fmt.Errorf("invalid port in address %q", addr)
	}
	host = strings.TrimSuffix(host, ".")
	ip := net.ParseIP(host)
	if !strings.EqualFold(host, "localhost") && (ip == nil || !ip.IsLoopback()) {
		return fmt.Errorf("refusing non-loopback address %q", addr)
	}
	return nil
}

func serveUntilSignal(srv *http.Server, ln net.Listener, logger *slog.Logger) int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		errCh <- srv.Serve(ln)
	}()

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server_failed", "err", err)
			return 1
		}
		return 0
	case <-ctx.Done():
		// Restore the default signal behavior during the graceful drain so a
		// second Ctrl-C/SIGTERM can force immediate termination.
		stop()
		logger.Info("shutting_down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			logger.Error("shutdown_failed", "err", err)
			return 1
		}
		if err := <-errCh; err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server_failed", "err", err)
			return 1
		}
		return 0
	}
}
