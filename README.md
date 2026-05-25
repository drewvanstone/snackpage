# snackpage

A keyboard-driven, snacks.nvim-inspired bookmark picker served from `localhost`. Built to be your default browser new-tab page so that **Cmd+T → type → Enter** reaches any saved URL in under two seconds.

[v1 design spec](docs/superpowers/specs/2026-05-23-snackpage-design.md)

## Install

Requires Go 1.22+.

```bash
git clone https://github.com/drewvanstone/snackpage.git
cd snackpage
make install            # installs to ~/.local/bin/snackpage
```

Ensure `~/.local/bin` is on your `$PATH`.

## Run

```bash
snackpage serve
# listening on 127.0.0.1:8765
```

First run creates `$XDG_DATA_HOME/snackpage/` (defaults to `~/.local/share/snackpage/`) with empty `bookmarks.json` and `state.json`.

Override the data dir with `--data-dir PATH`, the address with `--addr HOST:PORT`, and the log level with `--log-level debug|info|warn|error`.

### Demo

Try snackpage without committing real bookmarks:

```bash
snackpage demo
```

Seeds 100 well-known sites (Google, GitHub, Wikipedia, etc.) with a deterministic pseudo-random visit history into a tempdir and serves the picker. The tempdir is removed on shutdown — `$XDG_DATA_HOME/snackpage/` is never touched.

### Adding from the command line

Add a single bookmark from your shell:

```bash
snackpage add https://example.com --title "Example" --tags work,demo --aliases ex
```

If a snackpage daemon is running, the add goes through its API (so the picker updates immediately). If no daemon is running, the bookmark is written directly to `$XDG_DATA_HOME/snackpage/bookmarks.json`. Either way, the result is the same.

### Importing from Chrome

Bulk-import your existing Chrome bookmarks:

```bash
# Preview what would be imported
snackpage import chrome --dry-run

# Do it
snackpage import chrome

# Limit to a single folder
snackpage import chrome --folder "Bookmarks bar/Dev"

# Different profile
snackpage import chrome --profile "Profile 2"
```

Each Chrome bookmark's immediate-parent folder name becomes its tag (lowercased). URLs that already exist in snackpage are skipped — so re-running is idempotent.

Supported on macOS (`~/Library/Application Support/Google/Chrome/<profile>/Bookmarks`) and Linux (`~/.config/google-chrome/<profile>/Bookmarks`). Use `--path` to point at the Bookmarks file directly on other platforms.

## Point your browser at it

`snackpage` serves at `http://127.0.0.1:8765`. The trick is making **Cmd+T** open it instead of the browser's default new-tab page.

### Chrome / Brave / Edge

Chrome's "On startup" setting controls cold-launch only — it does **not** override `Cmd+T`. You have two options:

**Option A: Use a "New Tab Redirect" extension.**

1. Install from the Chrome Web Store: search for "New Tab Redirect" by Justin Henry (or any reputable equivalent — the manifest is trivial).
2. Set the redirect URL to `http://127.0.0.1:8765`.
3. Cmd+T → snackpage.

**Option B: Set the `NewTabPageLocation` Chrome policy.**

```bash
defaults write com.google.Chrome NewTabPageLocation -string "http://127.0.0.1:8765/"
# fully quit and relaunch Chrome
```

This is enterprise policy territory. If your Chrome is managed by your employer, IT policy may override `defaults` settings — verify in `chrome://policy` that `NewTabPageLocation` is `Set by the user`. If it shows `Mandatory` or `Recommended` from your platform policy, use Option A.

### Safari / Vivaldi (native, no extension)

Safari: *Preferences → General → New tabs open with: Homepage*. Set Homepage to `http://127.0.0.1:8765`.

Vivaldi: *Settings → Startup → Start Page → Specific page*. Set to `http://127.0.0.1:8765`.

### Firefox

Install [New Tab Override](https://addons.mozilla.org/firefox/addon/new-tab-override/) and set the URL to `http://127.0.0.1:8765`.

## Use

### Modes

snackpage is a vim-style modal editor:

- **Insert** (default on page load): typing filters the list, search input is focused, prompt glyph is yellow.
- **Normal** (after `Esc`): input blurred but query preserved, vim chords navigate and command, prompt glyph is mauve.

Toggle with `Esc` (insert → normal) and `i` / `a` / `/` (normal → insert).

The list starts empty — type to filter. Backspacing back to empty hides the list again. snackpage is a launcher, not a bookmark browser; the first keystroke is the point.

### Keyboard shortcuts

| Keys | Context | Action |
|---|---|---|
| `↑` / `↓` / `Ctrl+N` / `Ctrl+P` | any | Move selection |
| `Ctrl+D` / `Ctrl+U` | any | Half-page down / up |
| `⏎` | any | Open selected (replaces current tab) |
| `⌘⏎` / `Ctrl+⏎` | any | Open in a new tab |
| `⎋` | insert | Enter normal mode (preserves query) |
| `i` / `a` / `/` | normal | Enter insert mode |
| `j` / `k` | normal | Move selection |
| `g` `g` | normal | Top of list |
| `G` | normal | Bottom of list |
| `a` | normal | Add bookmark |
| `e` | normal | Edit selected |
| `d` `d` | normal | Delete selected |
| `u` | normal | Undo last add/edit/delete (per-view in-memory; restored deletes get a new id) |
| `?` | normal | Show keymap help overlay |
| `Tab` / `Shift+Tab` | modal | Cycle fields |
| `⏎` | modal | Save |
| `⎋` | modal | Cancel |

Reserved: `<Space>` in normal mode (future leader prefix for app commands).

### Manage view

Visit `http://localhost:8765/manage` for a spreadsheet-style table of all bookmarks. Useful after a Chrome import drops 60+ rows with mediocre auto-tags and you want to clean them up in bulk. `u` undoes the last change, which is where it shines — bulk edits get a per-row safety net.

- **Edit:** click any cell or Tab into it. Edits save automatically when you blur the cell (Tab away or click elsewhere). `Enter` saves the cell and jumps to the same column in the next row.
- **Revert:** press `Esc` inside a cell to restore its pre-edit value without saving.
- **Filter:** the filter input at the top is the first tab-stop. Fuzzy-matches across title / URL / tags / aliases; non-matching rows are hidden but kept in the DOM so in-flight edits aren't lost.
- **Add:** click `+ Add` (or press `o` / `O` in normal mode) to insert a draft row; fill in title and URL, blur, and the bookmark is created.
- **Delete:** click `✕` to arm the row (it turns red); click `✕` again within 2 seconds to confirm. Or use `dd` in normal mode — the chord IS the confirmation.
- **Undo:** `u` in normal mode reverses the last add / edit / delete. The stack lives in this view's memory only; refreshing or hopping to the picker resets it. Restored deletes get a fresh server id (the old one is gone).
- **Validation:** invalid URLs get a red outline; the cell stays in `.invalid` until you fix it or press `Esc` to revert.

Normal-mode keymap (Esc out of any cell or the filter to enter normal mode):

| Keys | Action |
|---|---|
| `h` / `j` / `k` / `l` | cell ← / row ↓ / row ↑ / cell → |
| `Ctrl+D` / `Ctrl+U` | half-page row scroll |
| `g` `g` / `G` | first / last row |
| `i` / `⏎` | edit current cell |
| `a` | edit, cursor at end |
| `o` / `O` | new row below / above |
| `d` `d` | delete current row |
| `u` | undo last add/edit/delete (per-view in-memory; restored deletes get a new id) |
| `/` | focus filter |
| `?` | help overlay |

Cross-link: there's a `manage` link in the picker footer and a `← picker` link at the top of the manage view.

## Storage

```
$XDG_DATA_HOME/snackpage/
├── bookmarks.json   # canonical, hand-editable, safe to back up via git
└── state.json       # visit counts and last-visit timestamps (churns; don't git)
```

To back up: copy `bookmarks.json` anywhere. To restore: drop it back in place.

## Development

```bash
make test       # unit + integration tests with race detector
make lint       # go vet (+ golangci-lint if installed)
make fmt        # gofmt -s -w
make run        # build and serve
```

## Architecture

A single Go binary embeds the entire frontend via `go:embed`. `internal/server` is stdlib `net/http` with mux pattern routing. `internal/store` is a JSON-on-disk store with atomic writes and an in-memory facade. `internal/frecency` is a pure scoring function. The frontend is vanilla JS using a vendored copy of [fzf-for-js](https://github.com/ajitid/fzf-for-js) for ranking.

See [`docs/superpowers/specs/2026-05-23-snackpage-design.md`](docs/superpowers/specs/2026-05-23-snackpage-design.md) for full design rationale and the v2+ roadmap.

## License

MIT. See `NOTICE` for third-party attributions.
