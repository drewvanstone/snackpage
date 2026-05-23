.PHONY: all build test lint fmt run clean install

BIN := snackpage
PREFIX ?= $(HOME)/.local
GOFLAGS := -trimpath
LDFLAGS := -s -w -X main.version=$(shell git describe --tags --always --dirty 2>/dev/null || echo dev)

all: build

build:
	go build $(GOFLAGS) -ldflags='$(LDFLAGS)' -o $(BIN) ./cmd/snackpage

test:
	go test ./... -race -cover

lint:
	go vet ./...
	@command -v golangci-lint >/dev/null && golangci-lint run ./... || echo "(golangci-lint not installed, skipping)"

fmt:
	gofmt -s -w .

run: build
	./$(BIN) serve

install: build
	install -d $(PREFIX)/bin
	install -m 0755 $(BIN) $(PREFIX)/bin/

clean:
	rm -f $(BIN)
	rm -f coverage.out coverage.html
