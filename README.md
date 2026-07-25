# snackpage

A small, keyboard-driven bookmark start page that runs entirely on your
machine. Make it your browser's new-tab page, type a few characters, and press
Enter.

snackpage is a single Go binary with an embedded vanilla-JavaScript frontend.
Bookmarks are stored as readable JSON; there is no account, cloud service,
telemetry, or runtime network dependency.

## Install

snackpage supports macOS and Linux and requires Go 1.26.1 or newer.

```bash
git clone https://github.com/drewvanstone/snackpage.git
cd snackpage
make install
```

This installs `snackpage` to `~/.local/bin` by default. Set `PREFIX` to choose
another prefix, and ensure its `bin` directory is on your `PATH`.

## Run

```bash
snackpage serve
# listening on 127.0.0.1:8765
```

Open `http://127.0.0.1:8765`. The server accepts loopback addresses only
because it intentionally has no authentication or TLS.

At startup, snackpage creates the data directory and initializes both JSON
files when they are missing:

```text
$XDG_DATA_HOME/snackpage/        # ~/.local/share/snackpage by default
├── .snackpage.lock              # exclusive writer lock
├── bookmarks.json               # canonical bookmark library
└── state.json                   # volatile visit statistics
```

Use `--data-dir PATH` to override the data directory, `--addr HOST:PORT` to
change the loopback listener, and `--log-level debug|info|warn|error` to set
logging. `--dev` disables browser caching for local frontend work.

Only one snackpage process may own a data directory at a time. A second daemon
or an offline CLI write exits without changing the files.

### Demo

```bash
snackpage demo
```

Demo mode seeds 100 bookmarks in a temporary directory, serves them, and
removes the directory on shutdown. It never touches your normal data.

## Add and import bookmarks

Add one bookmark from the shell:

```bash
snackpage add example.com --title "Example" --tags work,demo --aliases ex
```

Bare hostnames are normalized to `https://`. By default, the CLI sends the
mutation to the daemon at `127.0.0.1:8765`. If that exact address refuses the
connection, it acquires the data-directory lock and writes offline. A timeout,
reset connection, or malformed success response is reported as an unknown
outcome and is never retried directly, preventing accidental duplicates.

Use a non-default daemon address with `--addr`. To intentionally bypass the
HTTP API, first stop the daemon and pass `--offline`:

```bash
snackpage add example.com --offline
```

Import Chrome bookmarks in one atomic batch:

```bash
# Preview only
snackpage import chrome --dry-run

# Import through the running daemon
snackpage import chrome

# Other common options
snackpage import chrome --folder "Bookmarks bar/Dev"
snackpage import chrome --profile "Profile 2"
snackpage import chrome --addr 127.0.0.1:9999

# Explicit direct write; the daemon must be stopped
snackpage import chrome --offline
```

The immediate parent folder becomes a lowercase tag. Existing URLs and
duplicates within the Chrome source are skipped, so rerunning an import is
idempotent. Chrome entries with an empty title or invalid URL are reported and
ignored before the remaining valid entries are submitted as one atomic batch.
If that batch cannot be committed, none of it is written.

Chrome bookmark discovery supports:

- macOS: `~/Library/Application Support/Google/Chrome/<profile>/Bookmarks`
- Linux: `~/.config/google-chrome/<profile>/Bookmarks`

Use `--path FILE` to select a file explicitly.

## Make it the new-tab page

snackpage's default URL is `http://127.0.0.1:8765`.

### Chrome, Brave, and Edge

Install a reputable new-tab redirect extension and set its target to the
snackpage URL. The browser's “On startup” preference does not change new tabs.

Chrome gives a new tab's initial keyboard focus to the address bar, so the
redirect extension must transfer focus into the loaded page before snackpage
can focus its search field. If you use **Custom New Tab**, open its extension
options and clear **Focus on the address bar on the new tab page**. With that
option cleared, its page navigation hands focus to snackpage and the search
field's autofocus takes effect. Leaving it selected deliberately keeps typing
in Chrome's address bar. See Chrome's
[new-tab override guidance](https://developer.chrome.com/docs/extensions/develop/ui/override-chrome-pages#best-practices).

Chrome's `NewTabPageLocation` is an enterprise-managed policy on macOS; a
normal `defaults write` command does not install a valid managed policy. If
your organization manages Chrome, an administrator can deploy the policy and
you can verify it at `chrome://policy`. Otherwise, use an extension.

### Firefox

Install a reputable new-tab override extension, such as
[New Tab Override](https://addons.mozilla.org/firefox/addon/new-tab-override/),
and set the snackpage URL.

### Safari and Vivaldi

- Safari: set the homepage to the snackpage URL, then choose “Homepage” for
  new tabs.
- Vivaldi: set the start page to the snackpage URL in Startup settings.

## Use the picker

The picker has two modes:

- **Insert mode** is active on page load. Typing filters bookmarks.
- **Normal mode** begins when you press `Esc`. Vim-style commands become
  active while the query remains visible.

An empty query hides the result list; snackpage is a launcher, not a bookmark
browser. Matching covers title, aliases, tags, and URL. Fuzzy match quality is
primary, but loose character sequences scattered through unrelated text are
discarded. Literal substrings lead the results and may be joined by close
matches in intentionally curated aliases and tags. With no literals, search
falls back to human-readable acronyms and then close omitted-character
matches. URL fuzziness stays within one hostname label; paths and query strings
must match literally, so unrelated URL components cannot combine into a
result. Server-computed frecency and alphabetical title provide stable
tie-breaking. Hovering a result moves the active selection and clicking it
opens the bookmark; the footer shows the version served by the running binary.

Every non-empty query also ends with a **Search Google for “…”** action.
Bookmark matches stay first and selected by default. When no bookmark
qualifies, the Google action is selected automatically; when bookmarks do
match, pressing `↑` from the first result wraps directly to it. `Enter` searches
in the current tab and `Cmd+Enter` / `Ctrl+Enter` searches in a new tab. The
query is sent to Google only when that action is opened, never while typing.

### Picker keyboard map

| Keys | Context | Action |
|---|---|---|
| `↑` / `↓` / `Ctrl+N` / `Ctrl+P` | either mode | Move selection |
| `Ctrl+D` / `Ctrl+U` | either mode | Half-page down / up |
| `Enter` | either mode | Open selected in the current tab |
| `Cmd+Enter` / `Ctrl+Enter` | either mode | Open selected in a new tab |
| `Esc` | insert | Enter normal mode and preserve the query |
| `i` / `/` | normal | Enter insert mode |
| `j` / `k` | normal | Move selection |
| `g g` / `G` | normal | First / last result |
| `a` | normal | Add bookmark |
| `e` | normal | Edit selected bookmark |
| `d d` | normal | Delete selected bookmark |
| `u` | normal | Undo the last add, edit, or delete |
| `?` | normal | Open keyboard help |
| `Space m` | normal | Open the manage view |
| `Space t` | normal | Open the theme picker |
| `Tab` / `Shift+Tab` | dialog | Cycle controls |
| `Enter` / `Esc` | dialog | Save / cancel |

Undo history is in memory for the current page and is cleared by a reload.
Mutations are single-flight. If the connection fails after a request starts
and snackpage cannot know whether it committed, the page blocks further writes
and asks you to reload instead of risking a duplicate retry.

## Manage bookmarks

Open `http://127.0.0.1:8765/manage` for a spreadsheet-style view.

- Click or tab into a cell to edit it. Blur saves automatically.
- `Enter` saves and moves to the same column in the next row.
- `Esc` reverts the current cell and returns to normal mode.
- The filter uses the picker's relevance rules across title, URL, tags, and
  aliases.
- `+ Add` inserts a draft row.
- The delete button requires a second click within two seconds; `d d` is the
  keyboard confirmation.
- Modifier-clicking a URL opens it in a new tab.
- Row saves are serialized; delete and undo briefly lock editing while their
  result is being reconciled.

### Manage keyboard map

| Keys | Action |
|---|---|
| `h` / `j` / `k` / `l` | Cell left / row down / row up / cell right |
| `Ctrl+D` / `Ctrl+U` | Half-page row scroll |
| `g g` / `G` | First / last row |
| `i` / `Enter` | Edit the current cell |
| `a` | Edit with the cursor at the end |
| `o` / `O` | Add a row below / above |
| `d d` | Delete the current row |
| `u` | Undo the last add, edit, or delete |
| `/` | Focus the filter |
| `?` | Open keyboard help |
| `Space p` | Return to the picker |
| `Space t` | Open the theme picker |

## Themes

Press `Space t` in normal mode to preview and select one of 18 bundled themes:

- Design-driven: Catppuccin Mocha (default), Classic Mac, Mono Light
- Dark: Dracula, Gruvbox Dark Medium, Nord, Tokyo Night, One Dark, Solarized
  Dark, Tomorrow Night, Monokai, Rosé Pine, Everforest Dark, Kanagawa, GitHub
  Dark
- Light: Catppuccin Latte, Solarized Light, GitHub Light

The selection is validated and saved in browser local storage. A valid
`?theme=<id>` URL parameter selects and saves that theme. All fonts, styles,
scripts, and theme assets are embedded; changing themes makes no external
request.

## Storage, backup, and manual edits

`bookmarks.json` is canonical, versioned, indented, and ordered for readable
diffs. `state.json` contains best-effort visit counts and timestamps; it is
safe to omit from backups.

Writes use a unique temporary file, file `fsync`, atomic rename, and directory
`fsync`. Canonical mutations are copy-on-write: a failed save leaves the
in-memory and on-disk bookmark set unchanged. Future schema versions are
rejected without rewriting them.

Rename is the logical commit point. If the following directory `fsync` fails,
snackpage logs a crash-durability warning but does not report the already
committed mutation as retryable, which could otherwise duplicate an add.

Malformed or semantically invalid schema-v1 `bookmarks.json` stops startup so
canonical data is never discarded. Because statistics are disposable, a
writable store open (daemon or offline CLI) copies an invalid schema-v1
`state.json` byte-for-byte to a unique `state.json.recovery-*` sibling, resets
it to empty schema-v1 state, and continues. A future-version state file is
still left untouched and rejected. Read-only dry runs treat invalid
current-version state as empty without creating or changing any file.

Copying `bookmarks.json` for backup is safe while snackpage runs because the
published file is always complete. Restoring, hand-editing, `git pull`, or
allowing Syncthing/iCloud/Dropbox to replace the file must happen only while
the daemon is stopped. The daemon holds an in-memory snapshot and deliberately
does not attempt live merge or conflict resolution. If the file changes
behind a running daemon, its next canonical mutation reports a conflict
instead of overwriting the external change.

Example backup:

```bash
cp ~/.local/share/snackpage/bookmarks.json \
  ~/backups/snackpage-$(date +%F).json
```

To restore, stop snackpage, replace `bookmarks.json`, then start it again. A
missing `state.json` is recreated with empty statistics.

## Development

Go 1.26.1+ is required. Browser tests use Node 24 LTS (pinned in `.nvmrc`) and
Playwright 1.61.

```bash
make help                   # show every target
make format-check           # verify gofmt -s
make lint                   # go vet + required golangci-lint
make test                   # Go tests with race detector and coverage
make e2e                    # fresh-daemon HTTP smoke test
make setup-frontend         # npm ci + install all Playwright browsers
make test-frontend          # full Chromium suite, one worker
make test-frontend-smoke    # read-only Firefox and WebKit smoke tests
make check                  # all local quality gates
```

Development servers are isolated from real data:

```bash
make dev                    # .dev/ on 127.0.0.1:8766
make dev-demo               # same, with demo bookmarks
make dev-add URL=example.com TITLE=Example
make dev-stop               # stops only the recorded dev PID
make dev-restart
```

Override the development port with `DEV_PORT=9999`. To run a second dev
instance concurrently, give it a distinct locked data directory too, for
example `make DEV_PORT=9999 DEV_DIR=.dev/9999 dev`. `make dev-stop` validates
the recorded command before sending a signal; it never kills an arbitrary
process merely because that process owns the port.

CI runs the race-enabled Go suite on macOS and Linux, plus format, lint, HTTP
E2E, full Chromium, and read-only Firefox/WebKit coverage on Ubuntu.
Playwright chooses a collision-resistant port per process; set
`SNACKPAGE_PLAYWRIGHT_PORT` to force one while debugging.

## Release

Releases are published from a clean, committed `main` branch. By default the
workflow selects the next minor version after the latest stable tag published
on `origin` and resets the patch component, so `v1.8.5` becomes `v1.9.0`:

```bash
make release-plan
make release
```

Pass `VERSION` only when intentionally choosing a different stable version:

```bash
make release-plan VERSION=1.8.6
make release VERSION=1.8.6
```

The release target runs `make check` before it changes any remote state. It
then creates and pushes the annotated tag, creates a GitHub release, calculates
the published archive checksum, updates and pushes
`drewvanstone/homebrew-tap`, upgrades the installed Homebrew formula, restarts
the service, and verifies both its version and health endpoint.

The target never stages or commits source changes. It requires all intended
project files to be committed, while allowing local untracked files beneath
`.claude/`. It also refuses a dirty, diverged, or unexpectedly ahead Homebrew
tap, a version that is not newer than the latest stable tag, or a release with
no new commit. Git-local locks prevent two release runs from sharing either
checkout. Remote release stages are detected on rerun, so the same command can
resume after a transient GitHub, network, or Homebrew failure. Formula changes
made before a failed tap commit are restored automatically. Once publication
begins, do not amend, rebase, or advance the source checkout until the workflow
finishes; a retry requires the existing tag and `HEAD` to resolve to the same
commit.

Immediately before remote publication, the selected version and source commit
are recorded in `.git/snackpage-release-version`. A failed run leaves that
local marker so plain `make release` resumes the same version and commit
instead of selecting another minor bump. The marker is removed after the
release, installation, restart, and health verification all succeed.

Release prerequisites are `git`, authenticated `gh`, Homebrew with the
`drewvanstone/tap` tap installed, Ruby, and the complete development/browser
test toolchain used by `make check`. The source and tap remotes must be
writable. The tap checkout must be on `main`, clean, and synchronized with
`origin/main`. The workflow publishes only stable `X.Y.Z` versions.

`make release-plan` is an informational preview based on local tags (or an
in-progress release marker). It deliberately makes no network request and does
not validate credentials or checkout state. The real target fetches `origin`
and recalculates the automatic version from its published stable tags before
performing the release checks.

## Architecture

The Go server uses `net/http`; `internal/store` owns the locked JSON snapshot;
and `internal/web` embeds the dependency-free runtime frontend. The HTTP API is
the mutation boundary while the daemon runs. See [ARCHITECTURE.md](ARCHITECTURE.md)
for data flow, consistency guarantees, API routes, and extension points.

The current [roadmap](ROADMAP.md) records active explorations and decision
gates. In particular, the
[Astryx evaluation](docs/research/2026-07-25-astryx.md) considers an isolated
richer manage view without committing the picker or current architecture to a
frontend framework.

The original [v1 design](docs/superpowers/specs/2026-05-23-snackpage-design.md)
and [implementation plan](docs/superpowers/plans/2026-05-23-snackpage-v1.md)
are retained as historical records and are not current operating instructions.

## License

snackpage is MIT licensed. The bundled `fzf-for-js` attribution and complete
BSD 3-Clause license text are in [NOTICE](NOTICE).
