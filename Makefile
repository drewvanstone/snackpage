.PHONY: all build test test-frontend setup-frontend lint fmt run dev-run dev-demo dev-add clean install e2e

BIN := snackpage
PREFIX ?= $(HOME)/.local
GOFLAGS := -trimpath
LDFLAGS := -s -w -X main.version=$(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

# Dev isolation: dev targets bind to a separate port and use a separate XDG
# data dir so they never collide with the installed instance running against
# real bookmarks. .dev/ is gitignored.
DEV_DIR  := .dev
DEV_PORT := 8766
DEV_ENV  := XDG_DATA_HOME=$(CURDIR)/$(DEV_DIR)

all: build

# CGO_ENABLED=0 produces a fully statically-linked binary — trivially
# portable across machines, no libc surprises, easier to package for
# distribution (Homebrew, container images, etc.).
build:
	CGO_ENABLED=0 go build $(GOFLAGS) -ldflags='$(LDFLAGS)' -o $(BIN) ./cmd/snackpage

test:
	go test ./... -race -cover

lint:
	go vet ./...
	@command -v golangci-lint >/dev/null && golangci-lint run ./... || echo "(golangci-lint not installed, skipping)"

fmt:
	gofmt -s -w .

run: build
	./$(BIN) serve

# Dev variants: isolated XDG data dir, alternate port. Safe to run alongside
# the installed instance.
dev-run: build
	@mkdir -p $(DEV_DIR)
	$(DEV_ENV) ./$(BIN) serve --addr 127.0.0.1:$(DEV_PORT) --dev

dev-demo: build
	@mkdir -p $(DEV_DIR)
	$(DEV_ENV) ./$(BIN) demo --addr 127.0.0.1:$(DEV_PORT) --dev

# Convenience: add a bookmark to the dev instance (assumes dev-run is up).
# Usage: make dev-add URL=https://example.com TITLE="Example" TAGS=demo
dev-add: build
	@mkdir -p $(DEV_DIR)
	$(DEV_ENV) ./$(BIN) add $(URL) --title "$(TITLE)" --tags "$(TAGS)" --addr 127.0.0.1:$(DEV_PORT)

install: build
	install -d $(PREFIX)/bin
	install -m 0755 $(BIN) $(PREFIX)/bin/

clean:
	rm -f $(BIN)
	rm -f coverage.out coverage.html
	rm -rf $(DEV_DIR)

e2e: build
	@bash scripts/e2e.sh

# Frontend smoke tests via Playwright. Run setup-frontend once; then
# test-frontend on every change. Spawns the binary via Playwright's
# webServer config and tears it down after.
setup-frontend:
	cd tests/frontend && npm install
	cd tests/frontend && npx playwright install chromium

test-frontend: build
	cd tests/frontend && npx playwright test
