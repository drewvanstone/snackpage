# snackpage architecture

Living architectural reference. Updated whenever the structure shifts. For *feature* roadmap, see [`docs/superpowers/specs/2026-05-23-snackpage-design.md`](docs/superpowers/specs/2026-05-23-snackpage-design.md) §10.

## 1. Identity

**snackpage is a personal bookmark datastore** that ships with a fuzzy-finder frontend.

This framing matters because it determines what's in the *core* and what's a *frontend*:

- The **core** owns the truth: a JSON-backed, version-headered, atomically-written bookmark library plus visit-count statistics. It exposes a stable HTTP and Go API.
- **Frontends** are downstream consumers. Today there's one: a snacks.nvim-style fuzzy picker served at `/`. Future frontends could include a Bubbletea TUI, alternative web layouts (compact vs detailed), a Chromium companion extension that mirrors the store into the browser's native bookmark UI (see spec §10.v4), or a Go SDK.

The implication: **changes to the bookmark domain ripple to every frontend, so the domain stays small, well-named, and stable. Changes to a single frontend are local.**

## 2. Design principles

- **Stdlib first.** stdlib `net/http`, `log/slog`, `embed`, `flag`. The only Go third-party in `go.sum` is whatever future libraries we add deliberately (currently zero direct deps beyond stdlib). The frontend has one vendored JS library (`fzf-for-js`).
- **Loopback by default.** Bind to `127.0.0.1`, no auth, no TLS, no CORS. A bookmark service is not a network service.
- **Files are the API.** `bookmarks.json` is hand-editable, diff-friendly, and git-syncable. Anyone with a text editor can recover from a corrupted state.
- **Atomic on disk.** Every write is `write-tmp → fsync → rename`. Partial writes don't happen.
- **Keyboard-driven, modal vim-style.** Insert mode for typing into inputs; normal mode for all commands. Normal-mode commands are vim-vocabulary chords (`a` add, `e` edit, `dd` delete, `gg`/`G` top/bottom). **No `⌘+letter` snackpage shortcuts** — they fight Chrome's hardcoded mappings, feel un-vim, and waste a key space we have no business taking. Reserved modifier shortcuts: `Enter` (open) and `⌘+Enter` (open in new tab) only. Future `<Space>` is the leader prefix for app-extension commands. Same keymap shape applies to picker, manage view, and TUI.
- **Theming is data.** Today: hardcoded Catppuccin Mocha. Target: base16-style palettes as drop-in files (see §7).
- **Pure functions where possible.** Frecency scoring, ID generation, atomic write, XDG resolution — all pure or trivially testable.

## 3. File responsibility table

```
cmd/snackpage/             CLI entry, one file per subcommand
├── main.go                Subcommand dispatch, --version, --help, signal handling
├── add.go                 `snackpage add URL …` — POST to running daemon, fall back to direct
├── demo.go                `snackpage demo` — ephemeral tempdir with seeded fixture data
├── demo_data.go           The 100 generic bookmarks the demo seeds
├── import.go              `snackpage import <source>` dispatcher (currently only `chrome`)
└── import_chrome.go       Chrome Bookmarks JSON parser + tree walker + profile discovery

internal/store/            DOMAIN + APPLICATION + INFRASTRUCTURE for bookmarks
├── types.go               Bookmark, Stats, BookmarksFile, StateFile (domain entities)
├── id.go                  NewID() — Crockford base32, crypto/rand, bias-free
├── frecency.go            (lives in internal/frecency/) — pure scoring function
├── atomic.go              atomicWriteFile — temp + fsync + rename
├── bookmarks.go           load/save bookmarks.json with schema version 1
├── state.go               load/save state.json with schema version 1
└── store.go               Store facade: New/List/Add/Update/Delete/Visit, RWMutex-guarded

internal/frecency/         DOMAIN — pure scoring
└── frecency.go            Score(visitCount, lastVisitAt, now) → float64

internal/xdg/              INFRASTRUCTURE — path resolution
└── xdg.go                 DataDir(app) honoring $XDG_DATA_HOME

internal/server/           INTERFACE — HTTP adapter on top of store
├── server.go              Mux setup, embed.FS subbing, handleIndex/handleHealthz
├── middleware.go          logRequests + recoverPanics
├── bookmarks.go           bookmarkView + handleListBookmarks/Create/Update/Delete
└── redirect.go            handleRedirect — /go/:id → 302 + best-effort Visit

internal/web/              INTERFACE — embedded picker frontend (one of N possible frontends)
├── web.go                 //go:embed assets — exposes FS to the server
└── assets/
    ├── index.html         Picker shell: prompt, list, footer, modal-root
    ├── manage.html        Manage view shell: header, table, modal-root
    ├── style.css          Structure-only base CSS (layout, sizes, spacing)
    ├── manage.css         Manage-specific layout (table, cells, cursor)
    ├── themes/            Built-in theme palettes (loaded by inline <head> bootstrap)
    │   ├── catppuccin-mocha.css   Default theme — dark mauve-accented palette
    │   └── classic-mac.css        System-6 monochrome (striped titlebar, stippled BG, B&W)
    ├── theme.js           Runtime theme switcher (currentTheme/setTheme/cycleTheme)
    ├── app.js             Picker logic: load, render, fuzzy-rank, keymap, modal
    ├── manage.js          Manage logic: rows, vim-modal cursor, CRUD on blur
    └── vendor/fzf.umd.min.js   fzf-for-js v0.5.2, vendored

scripts/                   Development scripts
└── e2e.sh                 End-to-end smoke test via curl against a fresh binary
```

## 4. Layers

snackpage is small enough that the layers live in adjacent packages rather than separate module roots, but it follows a domain-driven layering:

```
┌─────────────────────────────────────────────────────────────────┐
│  INTERFACES                                                     │
│    HTTP API (internal/server)   CLI (cmd/snackpage)             │
│    Picker frontend (internal/web/assets — vanilla JS)           │
│    Future: Bubbletea TUI, Chromium extension, Go SDK            │
└──────────────┬──────────────────────────────────────────────────┘
               │ depends on
               ▼
┌─────────────────────────────────────────────────────────────────┐
│  APPLICATION                                                    │
│    Store (internal/store/store.go)                              │
│      - Add/Update/Delete/Visit (mutations, validation, locking) │
│      - List (snapshot read)                                     │
│      - Atomic persistence orchestration                         │
└──────────────┬──────────────────────────────────────────────────┘
               │ depends on
               ▼
┌─────────────────────────────────────────────────────────────────┐
│  DOMAIN                                                         │
│    Entities: Bookmark, Stats, BookmarksFile, StateFile          │
│    Pure logic: frecency scoring, ID generation, validation      │
│      (no I/O, no time-of-day dependence, no globals)            │
└──────────────┬──────────────────────────────────────────────────┘
               │ persisted by
               ▼
┌─────────────────────────────────────────────────────────────────┐
│  INFRASTRUCTURE                                                 │
│    File I/O (internal/store/{atomic,bookmarks,state}.go)        │
│    XDG path resolution (internal/xdg)                           │
│    Embedded assets (internal/web)                               │
└─────────────────────────────────────────────────────────────────┘
```

Rules of dependency flow:
- Domain depends on nothing (pure stdlib only).
- Application depends on domain + infrastructure (via concrete types — interfaces are introduced when the second adapter materializes).
- Interfaces depend on application. No interface code reaches into infrastructure directly.

When something feels architecturally fishy, it's almost always a layer violation: an HTTP handler reaching for `os.ReadFile` instead of going through `Store`, or domain code calling `time.Now()` instead of accepting `now` as a parameter.

## 5. Data flow

### Opening the picker (Cmd+T → http://localhost:8765/)

```
Browser → server.handleIndex → serve internal/web/assets/index.html
       → app.js loads, fetches /api/bookmarks
       → server.handleListBookmarks → store.List() → snapshot (bms, stats)
       → bookmarkView{} merges stats into wire shape → JSON
       → app.js renders an EMPTY list (the picker is a launcher, not a browser)
```

### Search → Open

```
Empty input → render no rows (the picker is a launcher, not a bookmark browser).
Typed input → fzf-for-js scored ranking across title (weight 4) > aliases (3)
              > tags (2) > url (1). Frecency adds a small tiebreak nudge.

Keystroke → refresh() → fuzzyRank(query, state.bookmarks)
         → fzf-for-js scores each field (title×4 / aliases×3 / tags×2 / url×1)
         → frecency tiebreak → render

Enter → openSelected(false) → window.location = /go/:id
     → server.handleRedirect → store.Visit(id, now) [best-effort]
                              → 302 → bookmark.URL
```

### Add (in-page modal OR `snackpage add URL`)

```
Modal: ⌘I → openModal → user types → submit
            → fetch POST /api/bookmarks
            → server.handleCreateBookmark → store.Add(bm)
            → store.validateBookmark + normalize tags/aliases
            → bookmarks slice append (under Lock)
            → saveBookmarks (atomic write)
            → reload list, auto-select new row

CLI: `snackpage add URL …` → cmd/snackpage/add.go
     → try POST first (500ms timeout)
     → on transport failure → fall back to direct store.Add()
     → on HTTP 4xx/5xx → surface error, do NOT fall back
```

### Import from Chrome (`snackpage import chrome`)

```
runImport → runImportChrome → resolve --profile → Bookmarks file path
         → on ENOENT for --profile → listChromeProfiles → friendly error
         → parse JSON tree → walk → flatten with immediate-parent tag
         → store.New → dedupe against existing → store.Add per candidate
         → report counts
```

## 6. Concurrency & consistency

- `Store` is the single owner of in-memory bookmark and stats state. Guarded by one `sync.RWMutex`.
- `List` takes RLock and returns a deep-copied slice + map — callers cannot mutate the live state.
- `Add` / `Update` / `Delete` / `Visit` take Lock. They mutate in-memory state, then call `saveBookmarks` and/or `saveState` (each does its own `atomicWriteFile`).
- Persistence is `bookmarks.json` (canonical, ordered) and `state.json` (volatile, map-keyed). They live next to each other under `$XDG_DATA_HOME/snackpage/`.
- On any save failure inside Add/Update, the in-memory change rolls back. (Delete has a known two-file rollback gap when `saveState` fails after `saveBookmarks` succeeds — see spec §11 carryover items.)
- The HTTP server is **not** the source of truth for `state.json` order — multiple snackpage tabs can have stale views; reloading fetches the truth.

## 7. Extension points

Where to plug in new behavior:

| Want to add… | Touch | Don't touch |
|---|---|---|
| **New CLI subcommand** | `cmd/snackpage/<new>.go` + register in `main.go` switch + `printUsage` line | `internal/*` |
| **New HTTP route** | `internal/server/<area>.go` + register in `server.go`'s `Handler()` | `internal/store` (unless you genuinely need new domain ops) |
| **New bookmark field** | `internal/store/types.go` (struct + JSON tag), `validateBookmark` if validated, JS render in `app.js`, modal in `app.js`, server wire shape in `internal/server/bookmarks.go` | `internal/frecency` (purely score, doesn't see fields) |
| **New picker layout (compact / detailed)** | `internal/web/assets/style.css` + a layout-switcher hook in `app.js` reading from a future user-config file | The HTML structure shouldn't need changing for layout-only switches |
| **New theme** | Add `internal/web/assets/themes/<name>.css` and append an entry (`{id, name, description}`) to the `THEMES` array in `theme.js`. The CSS overrides Catppuccin var names (`--base`, `--mauve`, …) under a `[data-theme="<name>"]` selector and can layer on pseudo-element decorations (titlebar, mode chip, etc.). The inline `<head>` bootstrap resolves the active theme before paint; runtime swaps go through the `<Space>t` theme picker (with live preview). User themes from `$XDG_CONFIG_HOME/snackpage/themes/` remain a future addition (see §8). | The HTML structure or JS render — themes are purely CSS. |
| **Alternative frontend** (e.g. Bubbletea TUI) | New package under `internal/`, new subcommand under `cmd/snackpage/` that boots it, all reading from `store.Store` directly | Existing frontends should be untouched. |
| **New storage backend** (e.g. SQLite) | Introduce a `store.Repository` interface in domain, move file-backed code to `internal/store/file`, add `internal/store/sqlite` adapter. Today the interface is implicit because we have one adapter. | Defer interface extraction until the second adapter is real (YAGNI). |

## 8. Future directions

Aligned with Drew's vision for the project. Not committed roadmap (that's the spec); just architectural pointers.

**Base16-style theming.** Shipped in v1.7 as two built-in themes (`catppuccin-mocha`, `classic-mac`). Each theme is a single CSS file under `internal/web/assets/themes/` that overrides `--base` / `--mauve` / etc. CSS variables under a `[data-theme="<name>"]` selector, and can layer on pseudo-element decorations (e.g. classic-mac's striped titlebar, stippled desktop, mode chip). The base `style.css` is structure-only and references only variables. An inline `<head>` bootstrap resolves the active theme before paint (URL param > localStorage > default), and `theme.js` exposes a modal `openThemePicker()` for runtime swaps via `<Space>t` — j/k navigates with live preview, Enter commits to localStorage, Esc reverts. (The legacy `cycleTheme()` is still exported for future tooling.) User themes from `$XDG_CONFIG_HOME/snackpage/themes/<name>.css` remain a future addition. References: [base16 spec](https://github.com/chriskempson/base16), [Catppuccin's base16 ports](https://github.com/catppuccin/base16).

**Layout configuration.** Two-line stacked (current) is one option. Compact (single-line dense) and detailed (more metadata visible) are obvious siblings. Mechanism: a small `$XDG_CONFIG_HOME/snackpage/config.toml` (or `config.json` to avoid adding a TOML dep) with keys like `layout = "compact" | "detailed"`, `font_size = "sm" | "md" | "lg"`, `theme = "catppuccin-mocha"`. The server reads it at startup, includes it in the index.html as a `data-*` attribute or inline JS variable, the frontend reacts. Frontend layout switching is pure CSS; no new render logic needed.

**Bubbletea TUI.** A `snackpage tui` subcommand that boots a terminal picker reading from the same `store.Store`. Same fuzzy ranking, same keymap intent, no web server required. This is where Bubbletea would land. Keyboard discipline (modal editing, mode indicator) transfers directly from the web picker's vim-style modal design.

**Multiple browsers as views.** Spec §10.v4 — snackpage exports to (or live-syncs into) each browser's native bookmark UI. Each browser is a read-only mirror; snackpage stays canonical. Six tiers from `snackpage export html` through Chromium companion extension to Safari support.

**Eventually: a Go SDK.** Once `internal/store` stabilizes, lifting `Store` to `pkg/store` (with a documented API) lets other Go programs embed snackpage's library directly. Useful if a Drew-flavored alternative frontend wants direct access without going through HTTP.

## 9. Conventions

- **Error messages start with the subcommand name** (`snackpage add: not a valid URL`). Greppable, stable, identifies the source for users debugging via shell history.
- **Wrapping with `fmt.Errorf("...: %w", err)`** at every layer transition (file I/O → store → handler). Callers can `errors.Is`/`errors.As`.
- **JSON wire shapes** are separate from domain types: handlers map `store.Bookmark` → `bookmarkView` for output and `bookmarkInput` → `store.Bookmark` for input. This isolates the wire format from internal evolution.
- **HTTP routes** follow the resource-collection conventions of Go 1.22's `net/http` pattern matching: `GET /api/bookmarks`, `POST /api/bookmarks`, `PUT /api/bookmarks/{id}`, `DELETE /api/bookmarks/{id}`. Future routes use the same shape.
- **Subcommand commit prefix:** `feat(cmd):`, `fix(cmd):`, `feat(server):`, `feat(web):`, `feat(store):`, `docs:`, `test:`, `vendor:`, `chore:`. Conventional Commits, scope follows the directory.
- **No global mutable state** inside the binary. The CLI passes `*store.Store` and `*slog.Logger` through `server.New`; tests construct their own.
- **Tests are colocated** (`foo_test.go` next to `foo.go`). External test packages (`package store_test`) for testing the public API; internal (`package store`) for testing unexported helpers.

## 10. Things that look weird and aren't

A short list of "I'd refactor that" instincts that aren't actually bugs:

- **`store.normalizeTags` lowercases AND sorts; `normalizeAliases` only dedupes case-insensitively but preserves case.** Tags are categorical (sort = predictable display); aliases are search keys (case preserved for user intent).
- **`store.Update` silently overwrites `ID` and `CreatedAt` from the input.** This is correct — a client can't change identity. Documented in the doc comment.
- **`bookmarkView` embeds `store.Bookmark`.** The JSON tag on the embedded struct's fields gets promoted to the top level, giving us `{id, title, url, ..., visit_count, last_visit_at}` without re-declaring fields. Idiomatic Go.
- **Frecency formula is duplicated in `internal/frecency/frecency.go` (Go) and `internal/web/assets/app.js` (JS).** Deliberate. The picker filters and sorts in the browser without round-tripping through the server.
- **`internal/web/assets/` instead of `web/` at the project root.** `//go:embed` can't traverse `..` so the embed source has to live next to the package that does the embedding.
- **`cmd/snackpage/add.go` has a `splitFlagsAndPositionals` helper.** Stock `flag` stops at the first non-flag token, so `snackpage add https://… --title T` would be misread. The helper pre-partitions args. Note: the helper's known-flag whitelist is currently hardcoded (carryover item — should switch to `fs.VisitAll` discovery).
