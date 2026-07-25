# snackpage architecture

This is the current architectural reference. The documents under
`docs/superpowers/` are historical design and implementation records.

## 1. Product boundary

snackpage is a personal bookmark datastore with two browser views:

- `/` is the fast, keyboard-driven fuzzy picker.
- `/manage` is the spreadsheet-style maintenance view.

The bookmark library is canonical; both web views and the CLI are clients of
the same application boundary. The process is deliberately local and
single-user:

- one Go binary;
- one file-backed store;
- one embedded vanilla-JavaScript frontend;
- loopback HTTP only;
- no authentication, TLS, CORS, cloud service, runtime CDN, or telemetry;
- macOS and Linux support; Windows is outside the supported matrix.

The project stays stdlib-first. Go has no third-party runtime dependency. The
frontend's only runtime dependency is a vendored `fzf-for-js` file.

## 2. Components and ownership

```text
cmd/snackpage/
├── main.go                 process lifecycle, serve, loopback listener
├── demo.go                 isolated seeded demo server
├── add.go                  add command and URL normalization
├── import.go               import dispatcher
├── import_chrome.go        Chrome parser, preview, atomic batch import
├── api_client.go           bounded daemon HTTP client and outcome rules
└── demo_data.go            embedded demo fixture

internal/store/
├── types.go                bookmark, stats, and versioned file shapes
├── errors.go               typed error categories
├── id.go                   random Crockford-base32 IDs
├── atomic.go               durable same-directory atomic replacement
├── bookmarks.go            strict bookmark schema load/save/validation
├── state.go                strict statistics schema load/save/validation
└── store.go                lock-owning snapshot and mutation operations

internal/server/
├── server.go               routes, embedded assets, cache policy
├── middleware.go           logging, recovery, Host/Origin/security policy
├── bookmarks.go            JSON wire types, CRUD, batch, error mapping
└── redirect.go             bookmark redirect and best-effort visit tracking

internal/frecency/          pure server-side frecency calculation
internal/xdg/               XDG data-path resolution
internal/web/
├── web.go                  go:embed boundary
└── assets/
    ├── index.html          picker document shell
    ├── manage.html         manage document shell
    ├── app.js              picker state, ranking, commands, dialogs, undo
    ├── manage.js           row editor, serialized saves, commands, undo
    ├── search.js           shared bookmark relevance admission and scoring
    ├── web-search.js       web-search provider registry and URL construction
    ├── theme-registry.js   immutable list of the 18 valid themes
    ├── theme-bootstrap.js  validated pre-paint theme resolution
    ├── theme.js            runtime theme picker
    ├── style.css           shared structure and components
    ├── manage.css          table-specific structure
    ├── themes/             one embedded CSS file per theme
    └── vendor/             fzf-for-js v0.5.2

scripts/
├── e2e.sh                  isolated real-process HTTP smoke test
├── release.sh              guarded, restartable release orchestration
└── update-homebrew-formula.rb
                            exact Homebrew release-field updater
tests/frontend/             Playwright browser integration tests
.github/workflows/ci.yml    macOS/Linux Go and Ubuntu browser/tooling gates
```

Dependency direction is simple:

```text
HTTP / CLI / web interfaces
            │
            ▼
       store.Store
            │
            ▼
versioned JSON + atomic filesystem operations
```

`internal/frecency` and `internal/xdg` are small pure or nearly-pure support
packages. HTTP wire types remain separate from store types so API evolution
does not silently redefine the on-disk schema.

## 3. Storage model

The default data directory is `$XDG_DATA_HOME/snackpage`, falling back to
`~/.local/share/snackpage`.

```text
.snackpage.lock
bookmarks.json
state.json
```

### Canonical and volatile data

`bookmarks.json` is canonical. Schema version 1 stores ordered bookmarks with:

```text
id, title, url, tags, aliases, created_at
```

`state.json` is volatile and stores `visit_count` and `last_visit_at` by
bookmark ID. Losing it affects ranking history, not the bookmark library.
Orphaned statistics are pruned when a store opens and during relevant later
mutations.

Both files are initialized at schema version 1 when missing. Canonical
bookmarks are decoded strictly: unknown fields, malformed data, duplicate or
invalid IDs, invalid required fields, and unsupported schema versions cause
opening the store to fail.

State is also decoded strictly, but has a deliberate recovery boundary because
it is disposable. On a writable `Store.New`, malformed JSON or semantically
invalid schema-v1 state is copied byte-for-byte with mode `0600` to a unique
`state.json.recovery-*` sibling, then `state.json` is atomically reset to
schema v1 with empty stats. Unsupported state schema versions remain untouched
and cause opening the store to fail. A future schema is never rewritten by an
older binary.

### Single writer

`store.New` creates the directory, obtains an exclusive non-blocking
`.snackpage.lock` with `flock`, loads and validates both files, initializes
missing files, and retains the lock until `Store.Close`.

This makes the daemon the sole writer while it runs. Offline CLI mutations use
the same constructor and therefore fail safely if the daemon owns that data
directory. `LoadSnapshot` is the explicit non-creating, non-locking read path
for dry runs. It treats invalid current-version state as empty in memory and
never creates a recovery file or changes the source; future versions still
return an error.

The lock handles cooperating snackpage processes. A SHA-256 fingerprint of
`bookmarks.json` handles non-cooperating external writers: every canonical
mutation verifies that the published file still matches the snapshot. If a
text editor or sync tool replaced it, the mutation returns
`ErrExternalChange` rather than overwriting the external data. Recovery is to
close the process, inspect the file, and reopen it; there is intentionally no
live merge.

### In-process consistency

One `sync.RWMutex` protects a store's complete bookmark/statistics snapshot.
`List` deep-copies bookmarks, tags, aliases, and statistics, so clients cannot
mutate live state through returned slices or maps.

Canonical mutations are copy-on-write:

1. validate and normalize input;
2. clone the current snapshot;
3. apply the mutation to the clone;
4. verify the canonical file fingerprint;
5. persist the clone;
6. publish the new in-memory snapshot.

A canonical save failure therefore leaves both the published file and live
snapshot unchanged. `AddBatch` validates the entire request, removes duplicate
URLs, assigns collision-checked IDs, and publishes all created bookmarks with
one canonical write.

Deleting a bookmark persists the canonical deletion first, then prunes state
best-effort. Redirect tracking also treats state persistence as best-effort so
a statistics failure never blocks navigation.

### Durable replacement

Every JSON save:

1. creates a uniquely named temporary file in the target directory;
2. applies mode `0600`;
3. writes and `fsync`s the temporary file;
4. closes it;
5. atomically renames it over the destination;
6. `fsync`s the parent directory.

The data directory is created with mode `0700`. Same-directory rename is the
atomic publication point. A post-rename directory-sync or close failure is
logged as a crash-durability warning, but the mutation remains a logical
success: returning a normal error after publication would invite a replay that
could duplicate the operation.

### Bookmark normalization

- title and URL are trimmed and required;
- a URL without `://` receives `https://`;
- the parsed URL must contain a scheme and host;
- the project intentionally preserves the existing scheme policy rather than
  imposing an HTTP/HTTPS allowlist;
- tags are trimmed, lowercased, deduplicated, and sorted;
- aliases are trimmed and deduplicated case-insensitively while preserving the
  first spelling;
- IDs are eight-character Crockford base32 and generated until unique;
- `created_at` is assigned by the store and preserved by updates.

## 4. HTTP boundary

The daemon uses Go's method-aware `http.ServeMux`.

| Method | Path | Result |
|---|---|---|
| `GET` | `/` | Picker HTML |
| `GET` | `/manage` | Manage HTML |
| `GET` | `/static/*` | Embedded asset |
| `GET` | `/healthz` | Plain-text liveness |
| `GET` | `/api/bookmarks` | Bookmarks merged with stats and `frecency_score` |
| `POST` | `/api/bookmarks` | Create one bookmark |
| `POST` | `/api/bookmarks/batch` | Atomically create a deduplicated batch |
| `PUT` | `/api/bookmarks/{id}` | Replace editable fields |
| `DELETE` | `/api/bookmarks/{id}` | Delete bookmark |
| `GET` | `/go/{id}` | `302` redirect and best-effort visit |

The batch body is:

```json
{
  "bookmarks": [
    {"title": "Example", "url": "example.com", "tags": [], "aliases": []}
  ],
  "skip_existing_urls": true
}
```

The success response contains `created` and `skipped_existing`. Validation is
all-or-nothing and canonical persistence occurs once.

Mutation bodies must be `application/json`, are limited to 1 MiB, reject
unknown fields, and must contain exactly one JSON value. Typed store errors
map to stable HTTP categories:

- validation → `400`;
- missing ID → `404`;
- external canonical change or unsupported schema → `409`;
- locked store → `423`;
- persistence or unexpected failure → `500`.

`HEAD /go/{id}` can receive redirect metadata through Go's GET-pattern
semantics but never records a visit. Only a real GET navigation changes
statistics.

### Local security

Safety is layered even though the service is local:

- `serve` and `demo` validate and bind only loopback addresses;
- request `Host` must identify localhost or a loopback IP;
- browser mutation requests with an `Origin` must match the request scheme,
  host, and port;
- CORS is absent;
- strict CSP permits only embedded same-origin assets and forbids framing,
  objects, inline script, and external font/style/script fetches;
- COOP, Permissions-Policy, Referrer-Policy, frame, and MIME-sniffing headers
  are set;
- header, read, write, idle, and graceful-shutdown timeouts are bounded;
- listener failures reach the main return path and produce a nonzero exit.

HTML, health, API, and redirect responses use `Cache-Control: no-store`.
Redirects must reach the daemon on every navigation so a cached `302` cannot
bypass visit tracking. Production static assets may be retained only with
revalidation and carry the binary version in their document URLs. Dev mode
uses `no-store` for static assets as well.

## 5. CLI mutation semantics

`snackpage add` and `snackpage import chrome` are API-first. They contact the
configured loopback daemon and use its single live store.

Automatic direct-write fallback is deliberately narrow: it happens only when
the operating system reports a definitive connection refusal. An HTTP error,
timeout, reset, oversized response, read error, or malformed successful
response can follow a committed mutation, so the client reports an unknown
outcome and never retries it directly.

`--offline` explicitly bypasses HTTP but still must acquire the store lock.
Both commands accept `--addr`; direct paths accept `--data-dir`.

Chrome import parses and filters first, normalizes valid entries, then uses the
batch API or `Store.AddBatch`. Existing URLs and duplicates within the source
are skipped. `--dry-run` reads through the daemon when available or through
`LoadSnapshot`; it does not create the data directory or JSON files.

## 6. Frontend model

The runtime frontend has no npm dependency and no compilation step. HTML,
JavaScript, CSS, theme files, and `fzf-for-js` are embedded in the binary.
Node and Playwright are development-only browser-test dependencies.

### Picker

The picker fetches the bookmark view into memory. Typing builds weighted fzf
scores:

```text
title × 4 + aliases × 3 + tags × 2 + URL × 1
```

Literal substrings always qualify. Non-contiguous fzf matches qualify only
when the score for an individual field is at least 70% of the ideal contiguous
score for that query. Title, alias, and tag initials also support explicit
acronym matches. URL fuzzy matching is scoped to one hostname label, so
hostname characters cannot combine with a distant path or query component.
Literal matches lead and may be joined by threshold-qualified alias/tag
matches for queries of at least three characters because those fields are
intentionally curated search metadata. With no literals, the strongest
non-empty confidence tier wins: acronym, then quality-filtered fuzzy. The field
weights rank admitted matches; they cannot rescue weak title or hostname
matches when a literal result exists.

Every non-empty query appends one transient web-search action after the
qualified bookmarks. Google is the only configured provider, but URL
construction lives behind a provider definition so provider choice can become
configuration without changing result or navigation logic. Bookmark matches
remain selected first; the web action is selected only when no bookmark
qualifies or the user moves to it. It is never persisted, included in bookmark
counts or frecency, or sent over the network until activation.

Server-computed `frecency_score` is a small tie-breaker, followed by title, URL,
and ID for deterministic order. The browser does not duplicate the frecency
formula. Picker and manage filtering share these relevance rules. An empty
picker query deliberately renders no results.

Selection is tracked by bookmark ID, not array index. A new query selects the
top match and resets the result scroll position; reloads preserve the same
visible ID when possible. Page focus and `pageshow` refresh statistics after
returning from a navigation.

### Manage view

All manage writes pass through one mutation scheduler. Rows additionally
serialize their own create/update work so blur events cannot reorder writes,
duplicate a draft creation, or allow an older response to overwrite a newer
edit. Explicit delete/undo actions first drain observed row saves and
temporarily lock mutation controls; an undo reload therefore cannot discard an
edit against a row node it replaces. Successful server-normalized values
replace local values, the active filter is reapplied after mutations, and
failures stay visible.

Mode follows actual focused elements. Keyboard-driven blur/save/navigation
transitions mode synchronously so a delayed request cannot leave a focused
editor in normal mode.

### Dialogs, undo, and accessibility

Dialogs are named, trap focus, guard duplicate submission, and restore the
element that opened them. Picker results and theme choices use appropriate
combobox/listbox/option relationships. Editable controls and actions have
labels and native keyboard behavior.

Undo stacks are per-page and in memory. A failed undo is placed back on the
stack. Recreating a deleted bookmark produces a new ID, and older undo entries
are rekeyed so composed undo operations continue to address the restored
bookmark.

Picker mutations are single-flight. A transport failure or an unreadable
successful mutation response has an unknown outcome, so both views block
further mutations until a full reload instead of risking a duplicate retry.

### Themes

`theme-registry.js` is the single allowlist. `theme-bootstrap.js` validates URL
and local-storage input and applies an embedded stylesheet before first paint,
without CSP-unsafe inline script. `theme.js` owns live preview and commit.
Opening and closing the picker installs and removes its listeners; repeated
use does not accumulate handlers. All 18 themes are local, including their
font stacks.

## 7. Principal data flows

### Page load and search

```text
browser GET /
  → rendered embedded HTML with versioned asset URLs
  → GET /api/bookmarks
  → Store.List deep snapshot
  → server merges stats + computes frecency
  → browser filters locally with fzf
```

### Open

```text
Enter on selected ID
  → GET /go/{id}
  → find bookmark in Store snapshot
  → best-effort Store.Visit
  → 302 to bookmark URL
```

### Browser mutation

```text
validated dialog/cell values
  → strict JSON request
  → typed store operation
  → copy-on-write + fingerprint check + durable replacement
  → normalized server response
  → frontend state/render update
```

### Chrome import

```text
parse Chrome tree
  → select optional folder
  → normalize and discard invalid candidates
  → daemon batch request
      or locked offline AddBatch after definitive refusal / --offline
  → one canonical publication
```

## 8. Testing and release gates

- `go test ./... -race -cover` covers unit and HTTP integration behavior.
- `go vet` and `golangci-lint` are both mandatory; missing lint tooling is an
  error rather than a skipped check.
- `make format-check` fails on any `gofmt -s` difference.
- `scripts/e2e.sh` selects a free port, polls liveness while verifying the
  child remains alive, performs real CRUD and GET redirect traffic, and stops
  only its own child.
- The complete Playwright suite runs serially in Chromium to isolate mutating
  fixtures.
- Read-only smoke coverage runs in Firefox and WebKit.
- Concurrent Playwright invocations choose collision-resistant per-process
  server ports and artifact directories; `SNACKPAGE_PLAYWRIGHT_PORT` is the
  explicit debugging override.
- CI runs race-enabled Go tests on current Go 1.26 patch releases on macOS and
  Linux. Ubuntu also runs formatting, lint, HTTP E2E, and browser jobs.
- `make release` requires clean source and tap checkouts, runs every local gate
  before publication, then publishes an annotated Git tag and GitHub release.
  It selects the next minor version after the latest stable tag published on
  `origin` by default; `VERSION=X.Y.Z` overrides that choice. The Homebrew
  formula is derived from the published tag archive and its SHA-256 before the
  tap is committed. Repository-local locks serialize release runs, and a new
  release must descend from and differ from the latest published stable tag.
- Release stages are restartable. Existing tag, GitHub release, and tap stages
  are accepted only when they resolve to the requested commit, version, URL,
  and checksum. An in-progress version-and-commit marker under `.git` prevents
  an automatic retry from selecting a second version or different source
  commit. The source checkout must remain at that commit until every stage
  completes.

Node 24 LTS is pinned in `.nvmrc`; Playwright is exact-pinned in
`tests/frontend/package-lock.json`. Setup uses `npm ci`, and execution uses
only the locally installed Playwright binary.

## 9. Change rules

- Keep bookmark domain changes in `internal/store`; adapters translate at
  their boundaries.
- Add an interface only when a real second implementation needs it.
- Preserve typed errors across layers with `%w`; do not branch on error text.
- Pass time into pure domain functions.
- Route every JSON publication through `atomicWriteFile`.
- Any direct-write command must participate in the lifetime store lock.
- Do not add a network bind beyond loopback without redesigning authentication
  and transport security first.
- A new embedded JavaScript dependency requires a version, integrity record,
  and complete license attribution in `NOTICE`.
- A new theme adds one embedded CSS file and one entry to the validated shared
  registry.
- Update this file and the user-facing README when behavior or invariants
  change.

Deferred features include service/autostart installers, new import sources,
live synchronization/conflict merging, custom user themes, a TUI, alternate
storage engines, and first-party browser extensions. They are not assumptions
inside the current architecture.

An Astryx-backed manage view is also an exploration, not an accepted dependency
or migration. Any proof of concept must remain isolated, use embedded
same-origin assets, and preserve the current mutation and keyboard invariants.
See the [roadmap](ROADMAP.md) and
[research note](docs/research/2026-07-25-astryx.md).
