# snackpage — design

**Status:** draft, brainstormed 2026-05-23
**Owner:** Drew Flower (`dflower@nvidia.com`)
**Tagline:** A keyboard-driven, snacks.nvim-inspired bookmark picker that lives at your browser's new-tab page.

---

## 1. Overview

`snackpage` is a small Go daemon that serves a single HTML page from `localhost`. The page is a fuzzy-find bookmark picker modelled on `snacks.nvim`'s picker UX: type, narrow, press Enter, go. It is intended to be the default new-tab page in the user's browser, so the loop "Cmd+T → type a few characters → Enter" reliably opens any bookmark in under two seconds without touching the mouse.

Bookmarks live in a hand-editable JSON file. A sidecar JSON file holds click stats so the picker can sort by **frecency** (recency × frequency). All HTTP, all rendering, and all storage happen locally — no network calls, no cloud, no auth.

The binary doubles as a future static-site generator (`snackpage build`, deferred to v2) so the page can also be exported as a standalone `index.html`.

## 2. Goals & non-goals

### Goals (v1)

- **Sub-two-second navigation** from `Cmd+T` to any known URL via fuzzy match on title, URL, tags, and aliases.
- **Frecency-ranked default order** so the empty-input view is useful.
- **In-page CRUD** for bookmarks — add (⌘N), edit (⌘E), delete (⌘D) — no CLI, no hand-editing required.
- **JSON storage** at a standard XDG path, atomic writes, diff-friendly for git backup.
- **Standard Go and Unix conventions** — `cmd/`/`internal/` layout, XDG paths, stdlib `net/http`, structured logging via `log/slog`.
- **Catppuccin Mocha** styling out of the box, matching the rest of the user's environment.

### Non-goals (v1 — or possibly ever)

- Multi-user / multi-tenant support
- Hosted SaaS or remote sync
- Mobile / responsive layout for phones (keyboard-driven tool)
- E2E sync (Syncthing / git / iCloud on the JSON file is fine if desired)
- Auth / TLS (loopback only)
- Browser-extension hijacking of `Cmd+T` (use an off-the-shelf "New Tab Redirect" extension; first-party extension is a v4 idea)

## 3. Architecture

### Process model

A single Go binary with subcommands:

```
snackpage serve [--addr 127.0.0.1:8765] [--data-dir PATH]   # v1, primary
snackpage build [--out PATH]                                 # v2
snackpage version                                            # v1
```

`serve` is a long-running foreground process in v1. v2 wraps it in a macOS LaunchAgent for autostart (Linux gets a systemd unit; both are deferred). The server listens on `127.0.0.1` only — never `0.0.0.0`. No TLS, no auth.

All web assets (HTML, JS, CSS, the vendored `fzf-for-js` library) are embedded into the binary at compile time via `go:embed`. The compiled binary is fully self-contained: copy it anywhere, run it, the page works.

### High-level data flow

```
            ┌─────────────────────────┐
            │   Browser  (Chrome/…)   │
            │  new tab → localhost    │
            └────────────┬────────────┘
                         │ HTTP
            ┌────────────▼────────────┐
            │   snackpage serve       │
            │  (Go, stdlib net/http)  │
            │  embedded HTML/JS/CSS   │
            └────────────┬────────────┘
                         │ atomic read/write
            ┌────────────▼─────────────────────────────┐
            │  $XDG_DATA_HOME/snackpage/               │
            │    bookmarks.json   (canonical, git OK)  │
            │    state.json       (churn, do not git)  │
            └──────────────────────────────────────────┘
```

### Frontend rendering model

Server emits a thin HTML shell plus an embedded `app.js`. On load:

1. `app.js` fetches `/api/bookmarks` once — list held in memory.
2. Page renders the full list, frecency-sorted, with the search input focused and cursor blinking.
3. Every keystroke re-filters the in-memory list via `fzf-for-js` (an actual port of fzf's v2 algorithm, ~30 KB). Scores combine weighted field hits with frecency as a tiebreaker.
4. Mutations (`POST /api/bookmarks`, etc.) trigger a re-fetch of `/api/bookmarks` on success.

No SPA framework. Plain vanilla JS plus one templating-free HTML file. The cognitive surface is small enough that I can hold the entire frontend in my head while reading it.

## 4. Data model

### Storage location

```
$XDG_DATA_HOME/snackpage/          # defaults to ~/.local/share/snackpage/
├── bookmarks.json
└── state.json
```

`--data-dir` overrides. The directory is created with `0700` on first run.

### `bookmarks.json`

Hand-editable, ordered by `created_at`, version-headered for future migration:

```json
{
  "version": 1,
  "bookmarks": [
    {
      "id": "b7k3m2qa",
      "title": "Team Dashboard",
      "url": "https://jirasw.nvidia.com/secure/RapidBoard.jspa?rapidView=12345",
      "tags": ["work", "jira"],
      "aliases": ["team board", "sprint board", "nkx board"],
      "created_at": "2026-05-23T14:30:00Z"
    }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | 8-char Crockford base32, server-generated, stable across edits. Used in `/go/:id` URLs. |
| `title` | string | yes | Free text, user-set. No auto-fetch from URL in v1. |
| `url` | string | yes | Validated via `net/url.Parse` on write; must have scheme + host. |
| `tags` | string[] | no | Lowercased, trimmed, deduplicated on write. Empty array preserved. |
| `aliases` | string[] | no | Preserved as-given (case + punctuation). Searched but not displayed. |
| `created_at` | RFC 3339 string | yes | Set server-side on creation. |

### `state.json`

Map keyed by id, written on every `GET /go/:id` and on every `DELETE`:

```json
{
  "version": 1,
  "stats": {
    "b7k3m2qa": {
      "visit_count": 89,
      "last_visit_at": "2026-05-23T17:12:33Z"
    }
  }
}
```

State entries for unknown ids are pruned **lazily** at the next full save (no big-bang cleanup pass).

### Atomic writes

For both files: write to `<file>.tmp` → `fsync` → `rename` to final path. This protects against partial writes if the process is killed mid-write. The OS rename is atomic on the same filesystem.

In-process concurrency is mediated by one `sync.RWMutex` per file (`bookmarksMu`, `stateMu`). Reads can fan out, writes are serialized.

### Frecency formula

```text
days_since = floor((now - last_visit_at) / 24h)         # +∞ if never visited
decay = 1.0   if days_since <= 1
      = 0.6   if days_since <= 7
      = 0.3   if days_since <= 30
      = 0.1   otherwise

score = max(visit_count, 1) * decay
```

Floor on `visit_count` (clamping to 1) ensures brand-new and never-clicked bookmarks don't disappear forever at score zero. Lives in `internal/frecency` as a pure function with table-driven tests so the curve is easy to retune later. Ties (identical frecency scores) are broken by alphabetical title.

This frecency score has two uses, which differ slightly:
1. **Empty input — primary sort.** Bookmarks are listed in descending frecency, alphabetical tiebreak.
2. **Non-empty input — search tiebreak only.** The fzf match score dominates; frecency adds a small (`0.001×`) nudge so equal-quality fuzzy matches favor the more-likely-next-click. See §6 for the exact weighting.

### ID generation

8 chars from the Crockford base32 alphabet (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, no `I L O U`). Generated via `crypto/rand`. Collision probability with 8 chars is negligible at the bookmark counts a single user will reach; we'll detect-and-retry on the millionth-of-a-percent chance.

## 5. HTTP API

All routes live under one `http.ServeMux`. JSON request/response throughout, except for `/` (HTML), `/static/*` (assets), and `/go/:id` (302).

| Method | Path | Purpose | Response |
|---|---|---|---|
| GET | `/` | Serve embedded `index.html` | HTML |
| GET | `/static/*` | Embedded JS/CSS/fonts | static assets |
| GET | `/api/bookmarks` | All bookmarks, with stats merged in | `200 {"bookmarks":[{...}]}` |
| POST | `/api/bookmarks` | Create — body `{title,url,tags,aliases}` | `201 {bookmark}` |
| PUT | `/api/bookmarks/{id}` | Update — body same as POST | `200 {bookmark}` |
| DELETE | `/api/bookmarks/{id}` | Delete + prune stats | `204` |
| GET | `/go/{id}` | 302 redirect; bumps stats | `302 Location: <url>` |
| GET | `/healthz` | Liveness check (for future LaunchAgent) | `200 "ok"` |

Everything else returns 404. JSON errors use `{"error":"..."}` with proper status codes. **CORS is not enabled** — daemon binds to loopback only and same-origin from the served HTML is the only legitimate caller.

### Validation rules

- `title` and `url` required and non-empty after trim.
- `url` must parse via `net/url.Parse` and have non-empty `Scheme` and `Host`.
- `tags` and `aliases`: optional, trimmed of whitespace, empty strings filtered out.
- `tags` are lowercased and deduplicated; `aliases` preserve case.

Invalid input → `400 {"error":"<reason>"}`.

### Redirect-tracking semantics

`GET /go/:id`:

1. Look up bookmark; if not found, `404`.
2. Atomically increment `state.stats[id].visit_count` by 1.
3. Set `state.stats[id].last_visit_at = time.Now().UTC()`.
4. Persist `state.json` (atomic write).
5. Respond `302 Location: <bookmark.url>`.

Step 4 happens *before* the redirect response. If the disk write fails we still redirect (best-effort logging) — never block the navigation on a stats write.

## 6. UI behavior & keymap

### Visual model

Layout is "Option B" from brainstorming — two-line rows, title prominent, URL + tags muted below, last-visit right-aligned. Catppuccin Mocha palette. Monospace font (JetBrains Mono via system fallback chain).

```
snackpage
❯ kub|
  ▌  NVIDIA JIRA                                      3h ago
     jirasw.nvidia.com  ·  work, nv                  89 visits

     Kubernetes Docs                                  2d ago
     kubernetes.io  ·  k8s, docs                     47 visits

     ...
```

Selected row gets a soft mauve left-border and a translucent mauve background.

### Behavior

| Trigger | Behavior |
|---|---|
| Page load | Focus drops into search input. List renders frecency-sorted. |
| Typing | List re-filters via `fzf-for-js` on every keystroke. |
| Empty input | Frecency-sorted list (no filtering). |
| Selecting a row | Visual highlight; no other side-effects. |

### Search semantics

`fzf-for-js` scores each candidate per field, then a weighted sum is computed:

```
final_score = 4 * fzf(title)
            + 3 * fzf(aliases joined with space)
            + 2 * fzf(tags joined with space)
            + 1 * fzf(url)
            + 0.001 * frecency(bookmark)   # tiebreaker only
```

Bookmarks with `final_score == 0` (no field matches) are hidden. Empty input bypasses scoring entirely and orders by pure frecency.

### Keymap

| Keys | Context | Action |
|---|---|---|
| `↑` / `↓` / `Ctrl+N` / `Ctrl+P` | picker (any focus) | Move selection |
| `j` / `k` | picker (input empty or unfocused) | Move selection (vim convenience) |
| `j` / `k` | picker (input has text) | Type the character (does not navigate) |
| `⏎` | picker | Open selected via `/go/:id` (replaces tab) |
| `⌘⏎` / `Ctrl+⏎` | picker | Open in new tab via `window.open("/go/:id", "_blank")` |
| `⌘N` | picker | Open Add modal |
| `⌘E` | picker | Open Edit modal (prefilled from selected row) |
| `⌘D` | picker | Delete confirm — row reddens, second `⌘D` within 2s deletes; any other key / selection change cancels |
| `/` | picker | Focus search input (no-op if already focused) |
| `⎋` | picker | Clear input if non-empty, else blur input, else no-op |
| `Tab` / `Shift+Tab` | modal | Cycle fields: URL → Title → Tags → Aliases → Cancel → Save → URL |
| `⏎` | modal | Submit |
| `⌘⏎` | modal | Submit (muscle-memory parity with picker) |
| `⎋` | modal | Cancel & close |

Vim `j`/`k` are also enabled in the picker (the user prefers vim motions). They're only intercepted when the search input is empty *or* not focused — typing `j` into the search field still types `j`.

### Modal — add / edit

Same component, different title and initial values. Fields:

- **URL** — required, validated client-side as a URL before POST.
- **Title** — required, defaults to URL hostname if left blank.
- **Tags** — optional, comma-separated input → string array on save.
- **Aliases** — optional, comma-separated input → string array on save.

Modal traps focus. After successful save: modal closes, `/api/bookmarks` re-fetched, newly-created row auto-selected.

### Delete UX

`⌘D` on a selected row → row turns red, footer shows "Press ⌘D again to confirm." Second `⌘D` within 2s → row is deleted, list re-renders. Any other key cancels. No undo in v1 (toast undo is v1.1).

## 7. CLI

```
snackpage serve [flags]
  --addr string       Address to listen on (default "127.0.0.1:8765")
  --data-dir string   Override XDG data dir
  --log-level string  debug|info|warn|error  (default "info")

snackpage build [flags]    # v2
  --out string        Output directory (default "./dist")
  --data-dir string   Override XDG data dir

snackpage version           # prints version + git SHA + build date
snackpage --help
snackpage <subcmd> --help
```

Flag parsing via stdlib `flag` package. No `cobra`, no `urfave/cli`. Three subcommands is below the threshold where a framework starts paying for itself.

## 8. Project layout

```
snackpage/
├── cmd/snackpage/
│   └── main.go              # subcommand dispatch, flag parsing
├── internal/
│   ├── server/
│   │   ├── server.go        # mux, embed.FS, lifecycle
│   │   ├── bookmarks.go     # CRUD handlers
│   │   ├── redirect.go      # /go/:id handler + stats bump
│   │   ├── middleware.go    # logging, recovery, content-type
│   │   └── server_test.go
│   ├── store/
│   │   ├── store.go         # combined facade
│   │   ├── bookmarks.go     # bookmarks.json read/write
│   │   ├── state.go         # state.json read/write
│   │   ├── atomic.go        # write-tmp-and-rename helper
│   │   └── store_test.go
│   ├── frecency/
│   │   ├── frecency.go      # pure scoring fn
│   │   └── frecency_test.go # table-driven
│   └── xdg/
│       └── xdg.go           # XDG_DATA_HOME / XDG_CONFIG_HOME resolution
├── web/
│   ├── index.html           # one HTML file
│   ├── app.js               # vanilla JS, ~300 LOC target
│   ├── style.css            # Catppuccin Mocha
│   └── vendor/
│       └── fzf.min.js       # fzf-for-js, pinned version, attribution in NOTICE
├── testdata/
│   ├── bookmarks.golden.json
│   └── state.golden.json
├── docs/
│   └── superpowers/specs/2026-05-23-snackpage-design.md  # this file
├── NOTICE                   # licenses for vendored JS
├── go.mod
├── go.sum
├── Makefile                 # build, test, run, lint, fmt
├── README.md
└── .gitignore
```

## 9. Testing strategy

### Unit tests (per package)

- **`internal/frecency`** — table-driven tests across the decay curve, edge cases (never visited, far future, exactly-on-boundary).
- **`internal/store`** — round-trip read/write, atomic-rename failure paths, malformed JSON, concurrent reads, deduplication of tags.
- **`internal/xdg`** — env precedence, fallback to default, expansion of `~`.

### Integration tests (in `internal/server`)

- `httptest.NewServer` with a temporary `data-dir`.
- Each endpoint: happy path + at least two failure modes (400, 404).
- `/go/:id` bumps `state.json` exactly once per request, even under concurrent requests (use `t.Parallel` + a shared in-memory state).
- Atomic write verified by checking only the `.tmp` exists mid-write (`t.Cleanup` finishes the write).

### Frontend smoke test

A tiny `playwright` or `puppeteer` script (deferred to v1.1 if it adds friction) that loads `localhost:8765`, types `kub`, hits Enter, asserts we end up on a `/go/:id` redirect → expected URL. Not in v1's critical path.

### Coverage target

`go test -cover ./...` ≥ 80% on `internal/`. `cmd/snackpage` doesn't need coverage; it's just wiring.

## 10. Roadmap

### v1 (this spec)

`serve` daemon, full in-page CRUD, frecency, redirect tracking, embedded assets, README documents both the off-the-shelf Chrome extension recipe and the `defaults write com.google.Chrome NewTabPageLocation` policy fallback.

### v1.1 — polish

- Toast confirmations (Saved / Deleted)
- "Recently deleted" undo (5-second window, in-memory)
- `snackpage --version` with build info
- Fix `make lint` to surface golangci-lint findings instead of silencing them via `||`
- Optional Playwright smoke test wired into a Makefile target (run locally, not in CI)

### v1.4 — vim-chord keymap migration

**Motivation:** ⌘+letter shortcuts (⌘+I add, ⌘+E edit, ⌘+D delete) fight Chrome's hardcoded mappings (⌘+N broke us in v1.0; the rest are interceptable but feel un-vim). Move all snackpage app commands to normal-mode vim chords; keep only the universally-safe modifier shortcuts. Same keymap design will extend to the manage view (v3) and Bubbletea TUI (v3) cleanly.

**Behavior changes** (picker):

- Drop `⌘+I` (add), `⌘+E` (edit), `⌘+D` (delete) entirely.
- Add normal-mode chords:
  - `j` / `k` — move selection (kept from v1.2)
  - `g g` — top of list
  - `G` — bottom of list
  - `a` — open Add modal
  - `e` — open Edit modal on selected row
  - `d d` — delete selected (chord-based confirmation replaces the v1.2 two-tap ⌘+D arming UX; same protection, more vim-faithful)
  - `/` — focus filter (kept; also enters insert mode)
  - `?` — show keymap help overlay (small modal listing all chords)
- Reserve `<Space>` in normal mode as the **future leader prefix** for v3+ app-extension commands (jump to manage view, theme toggle, reload, etc.).
- Keep `Enter` (open) and `⌘+Enter` (open in new tab) — universally safe, no Chrome conflict.
- Insert mode unchanged: typing filters search, `Esc` enters normal.

**Implementation:**

- ~100 LOC change in `internal/web/assets/app.js`: introduce a chord-buffer + 500ms inter-key timeout. Replace the existing `if (e.key === ...)` branches in the normal-mode path with a dispatch table:

  ```javascript
  const CHORDS_NORMAL = {
    "j": () => move(1),
    "k": () => move(-1),
    "gg": () => moveTo(0),
    "G": () => moveTo(state.view.length - 1),
    "a": () => openAddModal(),
    "e": () => openEditModal(),
    "dd": () => deleteSelected(),
    "i": () => $q.focus(),
    "/": () => $q.focus(),
    "?": () => showHelpOverlay(),
  };
  ```

  with prefix-detection so `g` waits 500ms for the next key (resolves to `gg` if `g` follows, otherwise no-op).

- Action handlers are named functions, not anonymous — this is the seam where v3 keymap customization plugs in.
- README keymap table replaced; Playwright tests retargeted (`⌘+I` tests become `a` tests, etc.).

**Net result:** zero Chrome modifier collisions for snackpage app commands; vim-faithful end-to-end; the same keymap shape carries to manage view and TUI when those land.

### v2 — distribution & lifecycle

**Motivation:** "It should be easy to install snackpage and have it running in the background." Today it's `git clone && make install && snackpage serve` in a tmux pane — fine for me, hostile to anyone else. v2 makes it a one-liner on macOS and Linux. **Linux is first-class**, equal priority with macOS. **Windows is explicitly out of scope** (see Forever non-goals below).

Tiers, ordered cheapest-to-most-expensive so each can ship independently:

**2.1 — Static binary baseline.** Set `CGO_ENABLED=0` for the build so the binary is fully statically linked and trivially portable. Document `make install` (already exists; drops `snackpage` into `$PREFIX/bin`, default `~/.local/bin`). No new code; build-flag and README tweak. ~5 minutes.

**2.2 — `snackpage service` subcommand.** Pure-Go, no shell scripts. Generates and registers the platform-appropriate unit file:

- macOS: writes `~/Library/LaunchAgents/com.drewvanstone.snackpage.plist`, runs `launchctl load`.
- Linux: writes `~/.config/systemd/user/snackpage.service`, runs `systemctl --user enable --now snackpage`.

Subcommands:

| Verb | Behavior |
|---|---|
| `snackpage service install` | Write + register the unit file. Idempotent. |
| `snackpage service uninstall` | Stop and unregister. |
| `snackpage service status` | Show running state, last started, exit code. |
| `snackpage service logs [-f]` | Tail the daemon's log file. |

~200 LOC across `cmd/snackpage/service.go` + platform-specific helpers behind `// +build darwin` / `// +build linux` tags.

**2.3 — Homebrew formula in a personal tap.** `brew install drewvanstone/tap/snackpage`. The formula includes a `service do` block so `brew services start snackpage` works on macOS (via LaunchAgent) and Linux (via Linuxbrew + systemd) without the user touching unit files. Tap repo: `github.com/drewvanstone/homebrew-tap`. Formula is ~50 lines of Ruby. Drew also gains version pinning, auto-update path, and the standard `brew uninstall` for cleanup.

```ruby
class Snackpage < Formula
  desc "Personal bookmark datastore with a keyboard-driven picker"
  homepage "https://github.com/drewvanstone/snackpage"
  url "https://github.com/drewvanstone/snackpage/archive/v2.0.0.tar.gz"
  sha256 "…"
  license "MIT"

  depends_on "go" => :build

  def install
    system "go", "build", *std_go_args(ldflags: "-s -w -X main.version=#{version}")
  end

  service do
    run [opt_bin/"snackpage", "serve"]
    keep_alive true
    log_path var/"log/snackpage.log"
    error_log_path var/"log/snackpage.log"
  end
end
```

**2.4 — README installation matrix.** Clear sections: "macOS via Homebrew", "Linux via Homebrew", "Build from source", each with copy-pasteable steps. Replaces the current "git clone + make install" instruction. ~30 lines of README.

**2.5 — Local cross-platform verification.** No GitHub Actions. Build on macOS (the daily driver), cross-compile to Linux via Go's built-in cross-compilation (`GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build`), run the test suite + e2e against the Linux binary inside a Docker container (or OrbStack VM, or `colima`, or whatever container runtime is handy). New Makefile targets:

```makefile
build-linux:                  # cross-compile a Linux binary on macOS
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build \
	  $(GOFLAGS) -ldflags='$(LDFLAGS)' -o snackpage-linux ./cmd/snackpage

test-linux:                   # run Go tests in a Linux container against the source
	docker run --rm -v $(CURDIR):/src -w /src \
	  golang:$(GO_VERSION) go test ./... -race -cover

e2e-linux: build-linux        # run scripts/e2e.sh against the Linux binary in a container
	docker run --rm -v $(CURDIR):/src -w /src \
	  debian:stable-slim bash -c './snackpage-linux serve --addr 127.0.0.1:18765 --data-dir /tmp/data --log-level error & \
	    sleep 1 && curl -fsS http://127.0.0.1:18765/healthz'
	# (full e2e script will need a Linux-flavored variant; sketch only)

lint:                         # surface golangci-lint findings — no more `||` silencing
	go vet ./...
	golangci-lint run ./...
```

Catches platform-specific regressions (Chrome bookmarks path resolver, future systemd unit generator) before users hit them. No CI runner-minute costs, no workflow YAML, no GitHub-side state. Run `make test-linux` before tagging. If anyone ever wants a real CI matrix, it's a one-day port — but until then, manual local verification is the policy.

**2.6 — homebrew-core upstreaming** *(optional, much later).* Once snackpage is stable and externally tested, submit to homebrew-core so `brew install snackpage` works without the tap prefix. Multi-week review process; only worth it if other people start using snackpage.

**2.7 — Memorable local-domain URL.** Today the picker lives at `http://127.0.0.1:8765`. A friendlier URL would feel more "real" — and matters mostly for documentation/screenshots, since the URL is rarely typed in normal use (the new-tab override hides it). Three tiers, escalating in setup cost and payoff:

- **2.7a — `*.localhost` (zero config, available immediately).** Modern browsers resolve `snackpage.localhost` (and any `*.localhost`) to 127.0.0.1 per RFC 6761. No DNS edits, no daemon work. URL becomes `http://snackpage.localhost:8765` — port stays, but the host is memorable. Document in README as the recommended URL for the new-tab redirect.
- **2.7b — `*.local` via mDNS (macOS-native, no sudo).** Daemon publishes itself via Bonjour: roughly `dns-sd -P snackpage _http._tcp local 8765 snackpage.local 127.0.0.1`, either as a goroutine in `serve` using a small mDNS library or as a sibling launchd service. URL becomes `http://snackpage.local:8765`. macOS-first; Linux needs Avahi running (commonly present but not universal). Port stays unless we go to tier 2.7c.
- **2.7c — `/etc/hosts` + port 80 (the "real domain" path).** `snackpage service install` prompts for sudo once, adds `127.0.0.1 snackpage.local` to `/etc/hosts`, and configures launchd / systemd to give the daemon port 80 (or installs a tiny reverse proxy listening on 80 that forwards to 8765). URL becomes `http://snackpage.local` — no port. Most setup, most polished result.

Recommended sequencing: ship 2.7a (just a README sentence) alongside the brew install in 2.3, then evaluate whether 2.7b or 2.7c earn their complexity once you've been using snackpage at scale.

**Static export as a distribution-adjacent feature:** `snackpage build [--out DIR]` emits a standalone `index.html` with bookmarks inlined as JS data. Frecency runs in `localStorage`. Lets the picker work on a static host (or `file://`) with no daemon. Useful if Drew wants snackpage published to e.g. GitHub Pages from his work laptop. Lives in v2 but technically independent of the install/lifecycle story.

### v3 — power-user features

- `pinned` boolean field on Bookmark; pinned rows stick above the frecency list.
- Optional favicons cached to `$XDG_CACHE_HOME/snackpage/favicons/`, served via `/static/favicon/:host`.
- **Base16-style theming.** Shipped in v1.7 as two built-in themes (`catppuccin-mocha` default + `classic-mac` System-6 monochrome). Each theme is a single CSS file under `internal/web/assets/themes/` that overrides Catppuccin-named vars under a `[data-theme="<name>"]` selector. `<Space>t` cycles; `?theme=X` (URL) and `localStorage.snackpageTheme` (persisted) both select. User themes from `$XDG_CONFIG_HOME/snackpage/themes/` remain a v3+ addition. See `ARCHITECTURE.md` §8.
- **Layout configuration.** `$XDG_CONFIG_HOME/snackpage/config.json` exposes `layout = "compact" | "detailed"`, `font_size = "sm" | "md" | "lg"`, `theme = "<name>"`. Frontend layout switching is pure CSS; no new render logic.
- **Bubbletea TUI as a new frontend.** `snackpage tui` subcommand boots a terminal picker reading from the same `store.Store`. Same fuzzy ranking, same modal-editing discipline as the web picker.
- **Manage view (`/manage`).** Spreadsheet-style table of all bookmarks for bulk editing — important after a Chrome import drops 60+ rows with mediocre auto-tags. Each cell is an `<input>`; save on blur via existing PUT. Filter as first tab-stop. Same vim-modal keymap discipline as the picker: `j`/`k`/`h`/`l` cell nav in normal mode, `Enter`/`i` enters cell, `dd` deletes row, `o`/`O` insert new row, `/` focuses filter. No `⌘+letter` shortcuts. Reuses the v1.4 chord-dispatch layer.
- **Keyboard customization** — `$XDG_CONFIG_HOME/snackpage/keymap.json` lets users remap any normal-mode chord. Schema maps **action names** (e.g. `add`, `edit`, `delete-row`, `top`, `bottom`, `focus-filter`) to **key sequences** (e.g. `"a"`, `"e"`, `"dd"`, `"gg"`, `"G"`, `"/"`). The v1.4 chord-dispatch table is already structured around named action functions, so wiring in user config is a one-day refactor: load the JSON at frontend boot, merge it over the defaults, build the dispatch table from the merged map.

(`snackpage import chrome` already shipped in v1.3; see git history for that one.)

### v4 — snackpage as multi-browser bookmark backend

**Motivation:** I use Safari personally and Chrome at work (corporate-mandated). I want to own my bookmarks independent of any single browser, and have them portable across browsers AND across workstations. The browser's own bookmark UI (address-bar autocomplete, bookmarks bar, ⌘D bookmark-this-page dialog) should become a read-only mirror of snackpage. snackpage becomes the canonical source; each browser is a "view."

The data is already portable across workstations via the JSON file (sync via git/Syncthing/iCloud — see spec §10 non-goals). v4 is about making it portable across **browsers** too.

Implementation tiers, cumulative — ship the lowest tier first, add higher tiers if/when they earn it:

**4.1 — One-shot HTML export.** `snackpage export html [--out FILE]` writes the W3C Netscape Bookmark File format. Manual import into any browser. Trivial (~50 lines), multi-browser by accident, no extension required.

**4.2 — Direct file write per browser** (browser must be closed when run). `snackpage export chrome [--profile NAME]` writes Chrome's `Bookmarks` JSON with a top-level `snackpage` folder, subfolders by tag, the bookmark inside. If signed in, Chrome Sync replicates to other Chrome installs for free. Could be scheduled via LaunchAgent at e.g. 3am when Chrome is likely closed. ~150 lines per browser format. Each browser adds another `snackpage export <browser>` subcommand.

**4.3 — Chromium companion extension `snackpage-companion`.** Polls or subscribes to `localhost:8765/api/bookmarks` (SSE if we add it), mirrors snackpage into Chrome's bookmark folder live via `chrome.bookmarks` API. One-way sync, snackpage is canonical. Same codebase covers Chrome, Brave, Edge, Vivaldi, Arc, Opera. Folds in the new-tab override (replaces the off-the-shelf "New Tab Redirect") and a "Save current tab" hotkey (`Cmd+Shift+S`) that POSTs to the daemon and opens snackpage with the add modal prefilled.

**4.4 — Firefox port.** Same JS as 4.3, different `manifest.json` (background-page semantics, namespace differences). 5-line polyfill for `chrome.*` ↔ `browser.*`. ~1-2 hours from a working Chromium extension.

**4.5 — Safari support.** Xcode app wrapper + macOS signing. The extension JS itself is portable from 4.3; cost is in the ~500 lines of Swift boilerplate, the developer-signing dance, and "Allow Unsigned Extensions" toggling. ~1-2 days for a single-developer setup.

**4.6 — Two-way sync** (optional, not yet committed). User adds a bookmark via the browser's native ⌘D dialog → it flows back to snackpage. Adds conflict resolution to the design (what if the same URL is edited in both?). Real engineering project — probably gated on whether v4.3-4.5 actually meet daily needs.

### v5+ — beyond

- Possibly: importers for other browsers (`snackpage import safari`, `snackpage import firefox`) for one-shot migrations into snackpage.
- Possibly: a richer page-fetch tagging assistant (the Phase 2 Claude skill mentioned in §11) productized as a `--curate` flag on `import`.

### Forever non-goals

Multi-user, hosted SaaS, mobile-responsive layout, built-in sync, network exposure beyond loopback, **Windows support**. macOS and Linux are first-class. Windows might be possible (Go cross-compiles cleanly) but every macOS/Linux-specific path (LaunchAgent vs systemd vs Windows services; XDG vs `%LOCALAPPDATA%`; Chrome Bookmarks file location; `chmod 0700` semantics) adds a third path with no maintainer to test it. If anyone seriously wants Windows support, the right answer is for them to fork.

## 11. Open questions

None at time of writing. Decisions to revisit during implementation:

- Final default port (`8765` is a placeholder — verify it's not common in the user's environment).
- Whether to ship a `Brewfile`/`tap` for distribution after v1.1.
- Exact frecency curve numbers — these are a guess; tune after a week of dogfooding.
