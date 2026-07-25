# snackpage roadmap

This is the current planning and exploration record. Items here describe
directions worth testing, not promised releases or accepted architectural
changes. Shipped behavior is documented in `README.md`; current invariants live
in `ARCHITECTURE.md`.

The original
[v1 design and versioned roadmap](docs/superpowers/specs/2026-05-23-snackpage-design.md)
is retained as a historical record.

## Product direction

- Keep the picker fast, keyboard-first, and visually quiet.
- Preserve the local-first model: one embedded binary, loopback-only HTTP, and
  no runtime CDN or cloud dependency.
- Make bookmark management easier without weakening mutation safety, undo,
  accessibility, or Safari support.
- Add frontend framework and build complexity only when a concrete feature set
  earns it.

## Explorations

### Astryx-backed manage view

**Status:** research complete; isolated proof of concept is a candidate, with
no production migration decision.

Meta's Astryx design system could supply a richer data-table foundation and a
large catalog of controls for `/manage`: sorting, filtering, selection, column
configuration, tokenizers, menus, dialogs, and notifications. It does not
currently supply spreadsheet editing semantics such as cell transactions,
range selection, clipboard operations, formulas, undo, or virtualization.

The exploration should therefore be a separate `/manage-next` implementation,
not a rewrite of the picker or an in-place conversion of the current manager.
Before the prototype, extract the application-specific behavior from DOM nodes:

1. Define a column schema for parsing, formatting, validation, search, and
   editor choice.
2. Move load/create/update/delete/undo and unknown-outcome handling behind a
   bookmark-ID-based controller.
3. Express Vim navigation in row and column IDs rather than element identity.
4. Bundle exact-pinned React, StyleX, and Astryx assets at build time and serve
   them from the embedded, same-origin filesystem.
5. Use explicit edit, commit, and cancel actions; do not make blur the
   transaction boundary in a rerendering table.

The prototype is successful only if it:

- preserves the current create, edit, delete, undo, validation, and
  unknown-outcome behavior;
- preserves the complete Vim keymap and mouse workflows;
- passes the existing Chromium suite and targeted Firefox/WebKit coverage;
- has no Content Security Policy violations or runtime network dependency;
- demonstrates accessible editing and navigation, not only an accessible
  read-only table;
- maps at least one light and one dark Snackpage theme without runtime style
  injection;
- records production bundle size and performance with representative and
  1,000-row data sets; and
- demonstrates enough useful table and component behavior to justify the new
  production toolchain.

Promote the prototype only if it materially reduces the cost of planned
management features. Keep and refactor the vanilla manager if the product
remains a four-field bookmark table. If Excel-like behavior becomes a goal,
evaluate a dedicated grid or spreadsheet engine separately; Astryx can be the
visual shell but is not currently that engine.

Revisit Astryx's Table after its public row-navigation and virtualization work
lands, and again when the project reaches a stable release. See the full
[Astryx evaluation](docs/research/2026-07-25-astryx.md).

## Deferred candidates

These remain ideas rather than architectural assumptions:

- service and autostart installers;
- additional browser import and export formats;
- live synchronization and conflict merging;
- custom user themes;
- a terminal UI;
- alternate storage engines; and
- first-party browser extensions.
