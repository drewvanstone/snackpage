.PHONY: all help build test test-frontend setup-frontend lint fmt dev dev-demo dev-add dev-stop dev-restart clean install uninstall e2e

BIN := snackpage
PREFIX ?= $(HOME)/.local
GOFLAGS := -trimpath
LDFLAGS := -s -w -X main.version=$(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

# Dev isolation: dev targets bind to a separate port and use a separate XDG
# data dir so they never collide with the installed instance running against
# real bookmarks. .dev/ is gitignored. DEV_PORT is `?=` so a second dev
# instance can coexist via `make DEV_PORT=9999 dev` on a different port.
DEV_DIR  := .dev
DEV_PORT ?= 8766
DEV_ENV  := XDG_DATA_HOME=$(CURDIR)/$(DEV_DIR)

all: build

# `make help` scans this file for "target: ... ## description" lines.
# Add `## one-liner` after every user-facing target so it shows up here.
help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# CGO_ENABLED=0 produces a fully statically-linked binary — trivially
# portable across machines, no libc surprises, easier to package for
# distribution (Homebrew, container images, etc.).
build: ## Build the static snackpage binary
	CGO_ENABLED=0 go build $(GOFLAGS) -ldflags='$(LDFLAGS)' -o $(BIN) ./cmd/snackpage

test: ## Run Go unit + integration tests with race detector
	go test ./... -race -cover

lint: ## go vet (+ golangci-lint if installed)
	go vet ./...
	@command -v golangci-lint >/dev/null && golangci-lint run ./... || echo "(golangci-lint not installed, skipping)"

fmt: ## gofmt -s -w on the whole tree
	gofmt -s -w .

# Dev variants always bind $(DEV_PORT) against $(DEV_DIR), never the canonical
# 127.0.0.1:8765 + $XDG_DATA_HOME path. That port + data dir belong to the
# installed daemon (brew, etc.); having a make target reach for them risks
# two processes mutating the same bookmarks.json. If you want to test a
# fresh build against real data, run `./snackpage serve` by hand after
# stopping the installed service — make won't help you do it by accident.
dev: build ## Build + serve dev instance on :8766 against .dev/ (override DEV_PORT=...)
	@mkdir -p $(DEV_DIR)
	$(DEV_ENV) ./$(BIN) serve --addr 127.0.0.1:$(DEV_PORT) --dev

dev-demo: build ## Build + serve dev instance seeded with 100 demo bookmarks
	@mkdir -p $(DEV_DIR)
	$(DEV_ENV) ./$(BIN) demo --addr 127.0.0.1:$(DEV_PORT) --dev

# Stop whatever is listening on $(DEV_PORT). Useful when a dev daemon was
# launched headlessly (e.g. from an agent shell) and has no TTY to Ctrl-C,
# or when you just want a clean restart without hunting the PID by hand.
# SIGTERM first so the Go signal handler can shut down gracefully; if the
# port is still bound after ~2s, escalate to SIGKILL.
dev-stop: ## SIGTERM whatever is listening on :8766 (idempotent)
	@pid=$$(lsof -tiTCP:$(DEV_PORT) -sTCP:LISTEN 2>/dev/null); \
	 if [ -z "$$pid" ]; then echo "no dev daemon on :$(DEV_PORT)"; exit 0; fi; \
	 echo "stopping dev daemon (pid $$pid on :$(DEV_PORT))"; \
	 kill $$pid; \
	 for i in 1 2 3 4 5 6 7 8 9 10; do \
	   sleep 0.2; \
	   [ -z "$$(lsof -tiTCP:$(DEV_PORT) -sTCP:LISTEN 2>/dev/null)" ] && exit 0; \
	 done; \
	 echo "still bound after 2s, escalating to SIGKILL"; \
	 kill -9 $$pid 2>/dev/null || true

dev-restart: dev-stop dev ## Stop the dev daemon then start it again

# Convenience: add a bookmark to the dev instance (assumes `make dev` is up).
# Usage: make dev-add URL=https://example.com TITLE="Example" TAGS=demo
dev-add: build ## Add a bookmark to the dev instance — URL=... TITLE=... TAGS=...
	@mkdir -p $(DEV_DIR)
	$(DEV_ENV) ./$(BIN) add $(URL) --title "$(TITLE)" --tags "$(TAGS)" --addr 127.0.0.1:$(DEV_PORT)

install: build ## Install snackpage to ~/.local/bin (override with PREFIX=path)
	install -d $(PREFIX)/bin
	install -m 0755 $(BIN) $(PREFIX)/bin/

uninstall: ## Remove ~/.local/bin/snackpage (override with PREFIX=path)
	rm -f $(PREFIX)/bin/$(BIN)

clean: ## Remove built binary, coverage artifacts, and .dev/
	rm -f $(BIN)
	rm -f coverage.out coverage.html
	rm -rf $(DEV_DIR)

e2e: build ## End-to-end smoke test (curl against fresh binary)
	@./scripts/e2e.sh

# Frontend smoke tests via Playwright. Run setup-frontend once; then
# test-frontend on every change. Spawns the binary via Playwright's
# webServer config and tears it down after.
setup-frontend: ## Install Playwright + bundled Chromium (run once)
	cd tests/frontend && npm install
	cd tests/frontend && npx playwright install chromium

test-frontend: build ## Playwright smoke tests against a fresh binary
	cd tests/frontend && npx playwright test
