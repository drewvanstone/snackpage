.PHONY: all help build check test test-frontend test-frontend-smoke setup-frontend lint fmt format-check dev dev-demo dev-add dev-stop dev-restart clean install uninstall e2e release release-plan

BIN := snackpage
PREFIX ?= $(HOME)/.local
GOFLAGS := -trimpath
LDFLAGS := -s -w -X main.version=$(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

# Dev isolation: dev targets bind to a separate port and use a separate XDG
# data dir so they never collide with the installed instance running against
# real bookmarks. .dev/ is gitignored. A concurrent second dev instance must
# override both its port and locked data dir, for example:
# `make DEV_PORT=9999 DEV_DIR=.dev/9999 dev`.
DEV_DIR  := .dev
DEV_PORT ?= 8766
DEV_DATA_DIR := $(CURDIR)/$(DEV_DIR)
DEV_PID_FILE := $(DEV_DATA_DIR)/snackpage-$(DEV_PORT).pid
DEV_ENV  := XDG_DATA_HOME="$(DEV_DATA_DIR)"

all: build

# `make help` scans this file for "target: ... ## description" lines.
# Add `## one-liner` after every user-facing target so it shows up here.
help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# CGO_ENABLED=0 produces a fully statically-linked binary — trivially
# portable across machines, no libc surprises, easier to package for
# distribution (Homebrew, container images, etc.).
build: ## Build the static snackpage binary
	CGO_ENABLED=0 go build $(GOFLAGS) -ldflags='$(LDFLAGS)' -o $(BIN) ./cmd/snackpage

test: ## Run Go unit + integration tests with race detector
	go test ./... -race -cover

lint: ## Run go vet and golangci-lint (both required)
	go vet ./...
	@command -v golangci-lint >/dev/null || { echo "golangci-lint is required; install v2.11.4 or newer" >&2; exit 127; }
	golangci-lint run ./...

fmt: ## gofmt -s -w on the whole tree
	gofmt -s -w .

format-check: ## Fail if any Go file is not gofmt -s formatted
	@files="$$(gofmt -s -l .)" || exit $$?; \
	 if [ -n "$$files" ]; then \
	   echo "gofmt -s is required for:" >&2; \
	   echo "$$files" >&2; \
	   exit 1; \
	 fi

check: ## Run every local quality gate
	$(MAKE) format-check
	$(MAKE) lint
	$(MAKE) test
	$(MAKE) e2e
	$(MAKE) test-frontend
	$(MAKE) test-frontend-smoke

# Dev variants always bind $(DEV_PORT) against $(DEV_DIR), never the canonical
# 127.0.0.1:8765 + $XDG_DATA_HOME path. That port + data dir belong to the
# installed daemon (brew, etc.); having a make target reach for them risks
# two processes mutating the same bookmarks.json. If you want to test a
# fresh build against real data, run `./snackpage serve` by hand after
# stopping the installed service — make won't help you do it by accident.
define run_dev
	@mkdir -p "$(DEV_DATA_DIR)"
	@set -u; \
	 pid_file="$(DEV_PID_FILE)"; \
	 if ! (set -C; : > "$$pid_file") 2>/dev/null; then \
	   echo "refusing to start: $$pid_file already exists; run make dev-stop first" >&2; \
	   exit 1; \
	 fi; \
	 pid=""; \
	 cleanup() { \
	   recorded="$$(sed -n '1p' "$$pid_file" 2>/dev/null || true)"; \
	   if [ -z "$$pid" ] || [ "$$recorded" = "$$pid" ]; then rm -f "$$pid_file"; fi; \
	   if [ -n "$$pid" ] && kill -0 "$$pid" 2>/dev/null; then \
	     kill "$$pid" 2>/dev/null || true; \
	     wait "$$pid" 2>/dev/null || true; \
	   fi; \
	 }; \
	 trap cleanup EXIT HUP INT TERM; \
	 $(DEV_ENV) "$(CURDIR)/$(BIN)" $(1) --addr "127.0.0.1:$(DEV_PORT)" --dev & \
	 pid=$$!; \
	 if ! printf '%s\n' "$$pid" >> "$$pid_file"; then \
	   echo "could not record dev PID in $$pid_file" >&2; \
	   exit 1; \
	 fi; \
	 wait "$$pid"
endef

dev: build ## Build + serve dev instance on :8766 against .dev/ (override DEV_PORT=...)
	$(call run_dev,serve)

dev-demo: build ## Build + serve dev instance seeded with 100 demo bookmarks
	$(call run_dev,demo)

# Only stop the process recorded by `make dev`/`make dev-demo`. Validate the
# command before signalling so a stale/reused PID can never kill an unrelated
# process that happens to occupy the same port.
dev-stop: ## Stop the PID-tracked dev daemon on :8766 (idempotent)
	@pid_file="$(DEV_PID_FILE)"; \
	 if [ ! -f "$$pid_file" ]; then echo "no PID-tracked dev daemon on :$(DEV_PORT)"; exit 0; fi; \
	 pid="$$(sed -n '1p' "$$pid_file")"; \
	 case "$$pid" in ''|*[!0-9]*) echo "discarding invalid PID file $$pid_file"; rm -f "$$pid_file"; exit 0;; esac; \
	 if ! kill -0 "$$pid" 2>/dev/null; then echo "discarding stale PID file $$pid_file"; rm -f "$$pid_file"; exit 0; fi; \
	 command="$$(ps -p "$$pid" -o command= 2>/dev/null || true)"; \
	 case "$$command" in *"$(CURDIR)/$(BIN)"*"--addr 127.0.0.1:$(DEV_PORT)"*) ;; \
	   *) echo "refusing to stop PID $$pid: command does not match this snackpage dev instance" >&2; exit 1;; \
	 esac; \
	 echo "stopping snackpage dev daemon (pid $$pid on :$(DEV_PORT))"; \
	 kill "$$pid"; \
	 i=0; \
	 while kill -0 "$$pid" 2>/dev/null && [ "$$i" -lt 20 ]; do sleep 0.1; i=$$((i + 1)); done; \
	 if kill -0 "$$pid" 2>/dev/null; then \
	   echo "still running after 2s, escalating to SIGKILL"; \
	   kill -9 "$$pid"; \
	 fi; \
	 rm -f "$$pid_file"

dev-restart: ## Stop the dev daemon then start it again
	$(MAKE) dev-stop
	$(MAKE) dev

# Convenience: add a bookmark to the dev instance (assumes `make dev` is up).
# Usage: make dev-add URL=https://example.com TITLE="Example" TAGS=demo
dev-add: build ## Add a bookmark to the dev instance — URL=... TITLE=... TAGS=...
	@mkdir -p "$(DEV_DATA_DIR)"
	$(DEV_ENV) ./$(BIN) add --title "$(TITLE)" --tags "$(TAGS)" --addr "127.0.0.1:$(DEV_PORT)" -- "$(URL)"

install: build ## Install snackpage to ~/.local/bin (override with PREFIX=path)
	install -d "$(PREFIX)/bin"
	install -m 0755 "$(BIN)" "$(PREFIX)/bin/"

uninstall: ## Remove ~/.local/bin/snackpage (override with PREFIX=path)
	rm -f "$(PREFIX)/bin/$(BIN)"

release-plan: ## Preview the next minor release (optional VERSION=X.Y.Z)
	@/bin/bash ./scripts/release.sh --plan "$(VERSION)"

release: ## Publish the next minor release (optional VERSION=X.Y.Z)
	@/bin/bash ./scripts/release.sh "$(VERSION)"

clean: ## Remove build, coverage, development, and browser-test artifacts
	rm -f $(BIN)
	rm -f coverage.out coverage.html
	rm -rf "$(CURDIR)/.dev"
	rm -rf "$(CURDIR)/tests/frontend/test-results"
	rm -rf "$(CURDIR)/tests/frontend/playwright-report"
	rm -rf "$(CURDIR)/tests/frontend/blob-report"
	rm -rf "$(CURDIR)/tests/frontend/.cache"

e2e: build ## End-to-end smoke test (curl against fresh binary)
	@./scripts/e2e.sh

# Playwright runs from the committed lockfile and never downloads an unpinned
# package through npx. The config starts and tears down an isolated demo daemon.
setup-frontend: ## Install locked frontend deps + Chromium/Firefox/WebKit
	cd tests/frontend && npm ci
	cd tests/frontend && npx --no-install playwright install chromium firefox webkit

test-frontend: build ## Run the full Chromium Playwright suite serially
	cd tests/frontend && npm test

test-frontend-smoke: build ## Run read-only Firefox and WebKit smoke coverage
	cd tests/frontend && npm run test:smoke
