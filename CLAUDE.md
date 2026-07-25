# Repository instructions for AI assistants

Read `ARCHITECTURE.md` before changing behavior. `README.md` is the
user-facing contract. `ROADMAP.md` records current explorations, not accepted
architecture or executable plans. Files under `docs/superpowers/` are
historical records.

## Product identity

snackpage is a personal bookmark datastore with a fuzzy picker and manage
view. The bookmark library is canonical; a UI is a client of that library.
Domain changes therefore need coordinated store, HTTP, CLI, frontend, test, and
documentation updates.

The intended product remains small:

- Go stdlib first;
- vanilla JavaScript with no runtime build step;
- a single embedded runtime dependency, vendored `fzf-for-js`;
- XDG JSON storage;
- one writer per data directory;
- loopback HTTP only;
- macOS and Linux; no Windows support.

Do not introduce a framework, database, cloud service, authentication layer,
or repository abstraction unless a concrete requirement earns that cost.

## Non-negotiable invariants

### Storage

- `bookmarks.json` is canonical; `state.json` is volatile.
- Every writable store owns `.snackpage.lock` for its entire lifetime and must
  be closed.
- Dry-run/read-only paths use `store.LoadSnapshot` and must not create files.
- Mutations are copy-on-write. Never modify the live snapshot before canonical
  persistence succeeds.
- Check the bookmark fingerprint before every canonical write; surface an
  external-change conflict rather than overwriting it.
- Every JSON replacement goes through `internal/store/atomic.go`.
- Rename is the logical commit point. Report post-commit durability warnings,
  but never expose them as replayable mutation failures.
- Preserve strict schema validation and reject unsupported versions untouched.
  Invalid current-version bookmarks fail; invalid current-version state uses
  the documented recovery-copy/reset path only for writable `Store.New`.
- Return and wrap typed errors. Never branch on error strings.
- `List` returns deep copies, including nested tags and aliases.
- State persistence is best-effort where loss affects only visit statistics;
  canonical bookmark persistence is not.
- Manual edits, restores, `git pull`, and sync-tool replacements happen only
  while the daemon is stopped.

### Server and CLI

- Never listen on a non-loopback address.
- Keep Host and same-origin mutation checks plus the security headers.
- Mutation JSON stays content-type checked, bounded, unknown-field rejecting,
  and single-value only.
- HTTP wire types stay separate from on-disk domain types.
- Only a real GET redirect records a visit; HEAD does not.
- `add` and `import chrome` are API-first. Automatic disk fallback is allowed
  only for a definitive connection refusal.
- Timeouts, resets, response read/decode failures, and HTTP responses never
  trigger a direct retry because the mutation outcome may be unknown.
- `--offline` still acquires the same lifetime store lock.
- Keep user-facing errors prefixed with the subcommand name.

### Frontend

- Runtime code is plain JavaScript, HTML, and CSS. npm is test tooling only.
- Frecency is computed by Go and sent as `frecency_score`; do not copy the
  formula into JavaScript.
- Track selected bookmarks by ID, not array position.
- Serialize all manage writes through the global scheduler and preserve the
  additional per-row queues for ordered blur saves.
- Keep picker mutations single-flight. An unknown mutation outcome blocks
  further writes until a full reload; never retry it from the page.
- Apply normalized server responses instead of assuming the request payload is
  canonical.
- Keep web-search actions transient and provider-shaped. They must not enter
  bookmark storage, counts, or frecency, and no query leaves the browser until
  the user activates the action.
- Derive mode from actual focus and keep focus restoration/focus traps intact.
- Failed undo operations remain retryable; restored IDs must rekey dependent
  undo entries.
- Theme IDs come from the shared validated registry. Runtime assets must remain
  local and compatible with the CSP.
- Keyboard behavior must have a discoverable visible or help-overlay path.

## Change map

| Change | Required review surface |
|---|---|
| CLI subcommand or flag | `cmd/snackpage`, usage output, README, CLI tests |
| HTTP route or wire field | route registration, handler tests, ARCHITECTURE |
| Bookmark field | store schema/validation, HTTP mapping, both views, import behavior, docs |
| Storage invariant | store tests including failure paths, CLI lifecycle, server lifecycle, docs |
| Theme | CSS file, shared registry, theme tests, README theme count |
| Runtime JS dependency | vendored file, fixed version/hash, complete license in NOTICE |
| Architecture shift | ARCHITECTURE, README, this file |

## Testing

Run the narrowest relevant test while iterating, then finish with the
proportional project gates:

```bash
make format-check
make lint
make test
make e2e
make test-frontend
make test-frontend-smoke
```

`make check` runs all of them. `golangci-lint` is required and absence is a
failure.

Testing conventions:

- public Go APIs use external `package x_test` where practical;
- unexported helpers may use internal tests;
- filesystem tests use `t.TempDir()`;
- HTTP unit/integration tests use `httptest`, not a fixed real port;
- assert typed error identity with `errors.Is`/`errors.As`;
- storage failure tests assert both returned error and unchanged live/disk
  state;
- full mutating browser coverage is Chromium-only and serial;
- Firefox/WebKit coverage is read-only smoke;
- browser fixtures must clean up anything they create.

Node 24 LTS and Playwright 1.61 are pinned. Use `npm ci` and
`npx --no-install`; do not let npx download an unpinned package.

## Development workflow

Make targets isolate work from the installed daemon:

- `make dev` and `make dev-demo` use `.dev/` and port 8766;
- `DEV_PORT` selects another development port;
- `make dev-stop` stops only the validated PID recorded by the dev target;
- `make dev-add` sends to the isolated daemon;
- `make clean` removes only known build/test/dev artifacts.

Never point development automation at the user's default data directory.
Testing a fresh binary with real data is a deliberate manual operation after
the installed daemon is stopped.

`make release` is the only automated release path. With no `VERSION`, it bumps
the latest stable tag published on `origin` to the next minor version and
resets patch to zero; `VERSION=X.Y.Z` is the explicit override. It must keep
the source tree clean, run `make check` before publishing, use an annotated
stable-semver tag, checksum the GitHub-hosted tag archive, and update the
Homebrew tap before upgrading and restarting the installed service. It must
never stage or commit source changes. Only untracked `.claude/` files may be
ignored by its source-cleanliness check. Keep its atomic source/tap release
locks, in-progress release marker, monotonic-version and new-commit checks,
exact formula-content validation, and restartable remote-stage verification
intact.

## Style

- Names describe domain intent (`Visit`, `AddBatch`), not implementation.
- Comments explain constraints and surprises rather than restating code.
- Pass clocks or timestamps into pure logic; do not hide `time.Now()` there.
- Prefer small concrete types until a second implementation proves an
  interface is useful.
- Preserve browser shortcuts except for the documented Enter modifiers.
- Keep the normal-mode command vocabulary vim-like and consistent between
  picker and manage views.
- Use Conventional Commit prefixes when committing: `feat(scope):`,
  `fix(scope):`, `test:`, `docs:`, `chore:`, `vendor:`.
