# Claude instructions for the snackpage repo

This file is for AI assistants working in this repo. For *what* the project is, see [`ARCHITECTURE.md`](ARCHITECTURE.md). For the design spec and feature roadmap, see [`docs/superpowers/specs/2026-05-23-snackpage-design.md`](docs/superpowers/specs/2026-05-23-snackpage-design.md).

## Identity (read this first)

**snackpage is a personal bookmark datastore that ships with a fuzzy-finder frontend.**

Not "a picker that happens to store bookmarks." The bookmark library is the product; the picker is one frontend. Future frontends (Bubbletea TUI, Chromium companion extension, alternative web layouts) will plug into the same store. This framing matters because it tells you which changes are local (frontend) and which ripple everywhere (domain).

## Stack and discipline

- **Go stdlib first.** `net/http` 1.22 mux patterns, `log/slog`, `embed`, `flag`. No cobra, no chi, no viper.
- **Frontend is vanilla JS** plus one vendored library (`fzf-for-js`). No npm, no build step.
- **Domain-driven layering.** Domain (pure) → Application (`store.Store`) → Infrastructure (file I/O) → Interfaces (HTTP, CLI, web frontend). See `ARCHITECTURE.md` §4 for the dependency rules.
- **YAGNI on interfaces.** A `Repository` interface only earns its keep when a second adapter exists. Today we have one (file-backed JSON); don't introduce indirection.
- **Stdlib paths via XDG.** Data goes to `$XDG_DATA_HOME/snackpage/`, config (if/when added) to `$XDG_CONFIG_HOME/snackpage/`. Use `internal/xdg` for resolution.
- **Atomic writes everywhere on disk.** Anything that touches a JSON file goes through `internal/store/atomic.go`.
- **Loopback only.** `127.0.0.1`, no CORS, no auth. Never bind to `0.0.0.0` without an explicit user request.

## Maintenance rules

Before committing a change, check whether these files need updating:

| Change | Update |
|---|---|
| New CLI subcommand or flag | `cmd/snackpage/main.go` (switch + `printUsage`), `README.md` (Usage section), `ARCHITECTURE.md` §3 file table |
| New HTTP route | `internal/server/server.go` route registration, `ARCHITECTURE.md` §5 data flow if it's a new path |
| New bookmark field | `internal/store/types.go`, `validateBookmark`, `internal/server/bookmarks.go` wire shape, `internal/web/assets/app.js` render + modal, `ARCHITECTURE.md` §7 (the "new bookmark field" row), spec §4 data model |
| Architecture shift (new package, layer reorg, new frontend) | `ARCHITECTURE.md` (file table, layers, data flow), `CLAUDE.md` (identity if framing changes) |
| New feature with user-facing surface | `README.md` (Usage), spec §10 if it changes the roadmap shape |
| New dependency (Go or JS) | `go.mod` + `go.sum` for Go; `NOTICE` + sha256 in NOTICE for JS. Justify in the commit message: what does this earn that stdlib doesn't? |
| Spec carryover item resolved | Mention in the commit, remove from project memory's "carryover" list |

If you skipped one of these, ask yourself why before committing.

## Commit conventions

- **Conventional Commits.** `feat(scope):`, `fix(scope):`, `docs:`, `test:`, `chore:`, `vendor:`. Scope follows the directory (`cmd`, `server`, `store`, `web`, `frecency`, etc.).
- **One concern per commit.** A bug fix and a refactor are two commits.
- **Commit the test, then the implementation** when doing TDD — the failing test goes first so `git log -p` reads like the development story.
- **Co-authored-by Claude** when Claude wrote substantive code: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. Not for trivial edits.

## Testing discipline

- Per-package tests live next to the code (`foo_test.go` next to `foo.go`).
- **External `package x_test`** for the public API, **internal `package x`** for unexported helpers. Both can coexist in the same directory.
- `t.TempDir()` for any test that touches the filesystem. Never write to `$XDG_DATA_HOME`.
- `httptest.NewServer` for HTTP integration tests; never start a real listener on a fixed port from a test.
- `make test` is `go test ./... -race -cover`. Coverage targets per package:
  - `internal/frecency`, `internal/xdg`: 100% (pure stdlib, no excuses)
  - `internal/store`: ≥75% (atomic writes + concurrency)
  - `internal/server`: ≥80% (integration paths)
  - `cmd/snackpage`: not required (it's the entry point; covered by `make e2e`)
- `make e2e` runs `scripts/e2e.sh` — a curl-based end-to-end smoke test against a fresh binary. **Known flake:** uses `sleep 0.3` after starting the server; on cold-binary first launch it can race. Re-run usually succeeds. Replace with poll-until-healthz when annoyed enough.

## Dev workflow

- `make run` builds and runs against the **real** `$XDG_DATA_HOME/snackpage/`. Don't use this while iterating.
- `make dev-run` builds and runs against `.dev/` (isolated XDG dirs, port 8766). This is the daily-driver dev command. Same goes for `make dev-demo`.
- The two can run simultaneously (different ports + different data dirs), so you can have your real picker open in one tab and a dev instance in another.
- After dev work, `make clean` removes `.dev/` and the binary.

## Things to never do

- **Never commit `.dev/` or anything inside it.** It's in `.gitignore` for a reason.
- **Never bypass `internal/store/atomic.go` for a file write.** Raw `os.WriteFile` on `bookmarks.json` will eventually eat your data.
- **Never call `time.Now()` inside pure domain code.** Pass `now time.Time` as a parameter. (Frecency is the canonical example.)
- **Never introduce a third-party Go library** without justifying it in the commit message. The stdlib bar is high here.
- **Never modify a tagged commit** (`v1.0.0` through current). Tags are immutable history.
- **Never trust an HTTP error string for control flow.** The `bookmark not found` literal match in `handleUpdateBookmark` is a known fragility flagged in spec carryovers — replace with `errors.Is(err, store.ErrBookmarkNotFound)` when you have an excuse to touch it.

## Style nudges (Drew's preferences)

- **Names match what things do, not how they work.** `Store.Visit()` not `Store.IncrementCounterAndPersist()`.
- **Comments explain *why*, not *what*.** The code says what; the comment says the constraint or the surprise.
- **Errors are values, not exceptions.** Return them, wrap them with `%w`, let callers `errors.As` if they need to discriminate.
- **Prefer composition over inheritance.** snackpage has no inheritance because Go has no inheritance — but it also has minimal embedding, by design.
- **Vim/keyboard culture.** When designing UI affordances, ask "what's the keyboard path?" first. Mouse paths come second.

## When in doubt

Open `ARCHITECTURE.md` and check §7 (extension points) — it has a row for most kinds of change. If your change doesn't fit a row, the architecture probably needs a small update, not your code.
