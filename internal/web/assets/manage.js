// snackpage manage view — Phase B (vim-modal spreadsheet).
//
// Layered on top of Phase A's CRUD-on-blur spreadsheet, this adds a
// vim-style modal editor: insert mode (any cell or filter input focused)
// behaves like Phase A; normal mode (no input focused) gets vim chord
// navigation (hjkl/gg/G/dd/o/O/i/a/⏎/⌘⏎/?). Mode is driven by input
// focus/blur — Esc inside a cell reverts (Phase A) and then blurs into
// normal mode automatically.

import { cycleTheme } from "./theme.js";

const FIELDS = ["title", "url", "tags", "aliases"];
const MAX_COL = FIELDS.length - 1; // 0..3

const state = {
  bookmarks: [],            // server payload (raw rows)
  pendingDelete: null,      // { row, timer } — for two-tap mouse delete (Phase A)
  mode: "insert",           // "insert" | "normal"
  normalRow: 0,             // index into the currently visible row set
  normalCol: 0,             // 0..MAX_COL
  // In-memory undo stack — same shape as the picker's. Per-view; refreshing
  // /manage or hopping to the picker clears it.
  //   { kind: "add",    id }
  //   { kind: "edit",   id, prev: {title,url,tags,aliases} }
  //   { kind: "delete", prev: {title,url,tags,aliases} }
  undoStack: [],
};

const $managePage = document.getElementById("manage");
const $filter = document.getElementById("filter");
const $rows = document.getElementById("rows");
const $rowCount = document.getElementById("row-count");
const $addBtn = document.getElementById("add-btn");
const $hints = document.getElementById("hints");
const $modalRoot = document.getElementById("modal-root");
const $tableWrap = document.querySelector(".manage-table-wrap");

const HINTS = {
  insert:
    "Tab nav · ⎋ revert + normal · ⏎ save+down · ⌘⏎ open in new tab · ? help",
  normal:
    "hjkl nav · gg/G top/bottom · i/⏎ edit · a append · o/O new row · dd delete · / filter · ? help",
};

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function parseList(v) {
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function formatList(arr) {
  return (arr || []).join(", ");
}

// ---------------------------------------------------------------------------
// Initial load + render
// ---------------------------------------------------------------------------

async function load() {
  const r = await fetch("/api/bookmarks");
  const j = await r.json();
  state.bookmarks = j.bookmarks || [];
  renderAll();
}

function renderAll() {
  $rows.innerHTML = "";
  for (const b of state.bookmarks) {
    $rows.appendChild(buildRow(b));
  }
  refreshRowIndices();
  updateCount();
  renderCursor();
}

function updateCount() {
  const total = $rows.children.length;
  const visible = visibleRows().length;
  $rowCount.textContent =
    total === visible ? `${total} rows` : `${visible} / ${total} rows`;
}

// Build a <tr> for a bookmark. If b is null/undefined, the row is a draft
// (no data-id; POST on first valid blur).
function buildRow(b) {
  const tr = document.createElement("tr");
  if (b && b.id) tr.dataset.id = b.id;
  tr.innerHTML = `
    <td class="cell col-title" data-col-index="0"><input type="text" data-field="title" data-col-index="0" value="${escapeHTML(b?.title ?? "")}"></td>
    <td class="cell col-url" data-col-index="1"><input type="text" data-field="url" data-col-index="1" value="${escapeHTML(b?.url ?? "")}"></td>
    <td class="cell col-tags" data-col-index="2"><input type="text" data-field="tags" data-col-index="2" value="${escapeHTML(formatList(b?.tags))}"></td>
    <td class="cell col-aliases" data-col-index="3"><input type="text" data-field="aliases" data-col-index="3" value="${escapeHTML(formatList(b?.aliases))}"></td>
    <td class="col-del"><button type="button" class="del-btn" tabindex="-1" aria-label="delete">✕</button></td>
  `;
  attachRowHandlers(tr);
  return tr;
}

// Wire up the per-cell focus/blur/keydown handlers and the delete button.
function attachRowHandlers(tr) {
  const inputs = tr.querySelectorAll("input");
  inputs.forEach((input) => {
    input.addEventListener("focus", onCellFocus);
    input.addEventListener("blur", onCellBlur);
    input.addEventListener("keydown", onCellKeydown);
    // Cmd/Ctrl + click on a URL cell opens the URL in a new tab — mirrors
    // browser link-open semantics. Intercept at mousedown so the default
    // focus-on-click doesn't fire.
    if (input.dataset.field === "url") {
      input.addEventListener("mousedown", onUrlMouseDown);
    }
  });
  const delBtn = tr.querySelector(".del-btn");
  delBtn.addEventListener("click", onDeleteClick);
}

function onUrlMouseDown(e) {
  if (!(e.metaKey || e.ctrlKey)) return;
  const url = e.currentTarget.value.trim();
  if (!url) return;
  e.preventDefault();   // suppress the focus that would otherwise follow
  window.open(url, "_blank", "noopener");
}

// Re-index visible rows in the DOM order. Call after add/delete/filter.
function refreshRowIndices() {
  const rows = [...$rows.children];
  rows.forEach((tr, i) => { tr.dataset.rowIndex = String(i); });
}

function visibleRows() {
  return [...$rows.children].filter((tr) => tr.style.display !== "none");
}

// Return the currently-focused-in-normal-mode row, clamping normalRow to
// the visible set's bounds. If there are no visible rows, returns null.
function currentVisibleRow() {
  const vis = visibleRows();
  if (vis.length === 0) return null;
  if (state.normalRow >= vis.length) state.normalRow = vis.length - 1;
  if (state.normalRow < 0) state.normalRow = 0;
  return vis[state.normalRow];
}

function currentVisibleCell() {
  const tr = currentVisibleRow();
  if (!tr) return null;
  const td = tr.querySelectorAll("td.cell")[state.normalCol];
  return td || null;
}

// ---------------------------------------------------------------------------
// Mode + visual cursor
// ---------------------------------------------------------------------------

function setMode(m) {
  state.mode = m;
  if ($managePage) $managePage.dataset.mode = m;
  if ($hints) $hints.textContent = HINTS[m];
  renderCursor();
}

// Update data-current attributes for the active (row, col) and scroll the
// current cell into view. Only meaningful in normal mode visually, but we
// keep it consistent so JS can read state at any time.
function renderCursor() {
  // Clear previous markers.
  for (const tr of $rows.querySelectorAll("tr[data-current]")) {
    tr.removeAttribute("data-current");
    tr.removeAttribute("aria-current");
  }
  for (const td of $rows.querySelectorAll("td.cell[data-current]")) {
    td.removeAttribute("data-current");
  }

  const tr = currentVisibleRow();
  if (!tr) return;
  tr.dataset.current = "true";
  tr.setAttribute("aria-current", "row");

  const tds = tr.querySelectorAll("td.cell");
  const col = Math.max(0, Math.min(MAX_COL, state.normalCol));
  state.normalCol = col;
  const td = tds[col];
  if (td) {
    td.dataset.current = "true";
    if (state.mode === "normal") {
      td.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
}

function moveCursor(dCol, dRow) {
  const vis = visibleRows();
  if (vis.length === 0) return;
  state.normalCol = Math.max(0, Math.min(MAX_COL, state.normalCol + dCol));
  state.normalRow = Math.max(0, Math.min(vis.length - 1, state.normalRow + dRow));
  renderCursor();
}

function setCursor(col, row) {
  const vis = visibleRows();
  if (vis.length === 0) return;
  state.normalCol = Math.max(0, Math.min(MAX_COL, col));
  state.normalRow = Math.max(0, Math.min(vis.length - 1, row));
  renderCursor();
}

// Half-page row scroll. Use the table wrap as the scroll container and
// compute step size from the first visible row's offsetHeight.
function pageScrollRows(direction) {
  const vis = visibleRows();
  if (vis.length === 0) return;
  const firstRow = vis[0];
  const rowH = firstRow.offsetHeight || 1;
  // Use the scrolling container's clientHeight (the table-wrap div).
  const containerH = $tableWrap?.clientHeight || window.innerHeight;
  const halfVisible = Math.max(1, Math.floor(containerH / rowH / 2));
  state.normalRow = Math.max(
    0,
    Math.min(vis.length - 1, state.normalRow + direction * halfVisible),
  );
  renderCursor();
}

function focusCurrentCell(atEnd) {
  const td = currentVisibleCell();
  if (!td) return;
  const input = td.querySelector("input");
  if (!input) return;
  input.focus();
  if (atEnd) {
    const n = input.value.length;
    try { input.setSelectionRange(n, n); } catch { /* ignore */ }
  }
}

function deleteCurrentRow() {
  const tr = currentVisibleRow();
  if (!tr) return;
  deleteRow(tr);
}

async function deleteRow(tr) {
  // Clear any in-flight two-tap state — chord IS the confirmation.
  clearPendingDelete();

  // Draft row (no id): just remove from DOM. Nothing was POSTed, so no undo
  // entry — the server state never changed.
  if (!tr.dataset.id) {
    tr.remove();
    refreshRowIndices();
    updateCount();
    renderCursor();
    return;
  }

  // Snapshot the bookmark BEFORE the DELETE so undo can re-POST it.
  const id = tr.dataset.id;
  const before = state.bookmarks.find((b) => b.id === id);
  const prev = before
    ? {
        title: before.title,
        url: before.url,
        tags: [...(before.tags || [])],
        aliases: [...(before.aliases || [])],
      }
    : null;

  try {
    const r = await fetch(
      "/api/bookmarks/" + encodeURIComponent(id),
      { method: "DELETE" },
    );
    if (!r.ok && r.status !== 404) return;
    // Mirror the in-memory bookmarks list too.
    state.bookmarks = state.bookmarks.filter((b) => b.id !== id);
    tr.remove();
    refreshRowIndices();
    updateCount();
    renderCursor();
    if (prev) state.undoStack.push({ kind: "delete", prev });
  } catch {
    /* leave row alone on network failure */
  }
}

// Insert a fresh draft row above or below the current row (or at the top
// if there is no current row). Focuses the new row's title cell, which
// transitions us into insert mode via the focus listener.
function insertDraftRow(where) {
  const draft = buildRow(null);
  const current = currentVisibleRow();
  if (current && where === "above") {
    current.parentNode.insertBefore(draft, current);
  } else if (current && where === "below") {
    current.parentNode.insertBefore(draft, current.nextSibling);
  } else {
    $rows.insertBefore(draft, $rows.firstChild);
  }
  refreshRowIndices();
  updateCount();
  // After inserting, the new draft becomes the current row.
  const vis = visibleRows();
  const newIdx = vis.indexOf(draft);
  if (newIdx >= 0) state.normalRow = newIdx;
  state.normalCol = 0;
  renderCursor();
  // Focus the title input — this trips onCellFocus and enters insert mode.
  const titleInput = draft.querySelector('input[data-field="title"]');
  if (titleInput) titleInput.focus();
}

// Open the current row's URL in a new tab (⌘⏎ / Ctrl+⏎).
function openCurrentRowInNewTab() {
  const tr = currentVisibleRow();
  if (!tr) return;
  const url = tr.querySelector('input[data-field="url"]')?.value?.trim();
  if (!url) return;
  // No /go/ wrapper here — the manage view is for editing, not visit-tracking.
  window.open(url, "_blank");
}

// ---------------------------------------------------------------------------
// Cell editing (Phase A behavior preserved)
// ---------------------------------------------------------------------------

function onCellFocus(e) {
  // Stash the value so Esc can revert.
  e.target.dataset.original = e.target.value;
  // Any focus change cancels a pending mouse delete on another row.
  clearPendingDelete(e.target.closest("tr"));
  // Remember (row, col) for normal-mode return.
  const tr = e.target.closest("tr");
  if (tr) {
    const vis = visibleRows();
    const rIdx = vis.indexOf(tr);
    if (rIdx >= 0) state.normalRow = rIdx;
  }
  const cIdx = parseInt(e.target.dataset.colIndex, 10);
  if (!Number.isNaN(cIdx)) state.normalCol = cIdx;
  setMode("insert");
}

function onCellKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    revertCell(e.target);
    e.target.blur();
    return;
  }
  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    // Synthetic save: trigger blur (which saves if dirty + valid), then move
    // focus to the same column in the next row.
    const field = e.target.dataset.field;
    const tr = e.target.closest("tr");
    e.target.blur();
    // Find the next visible sibling row.
    let next = tr.nextElementSibling;
    while (next && next.style.display === "none") next = next.nextElementSibling;
    if (next) {
      const sel = `input[data-field="${field}"]`;
      const targetInput = next.querySelector(sel);
      if (targetInput) targetInput.focus();
    }
    return;
  }
  // Arrow Up/Down in an input cell: save current + move row in same column.
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    const dir = e.key === "ArrowDown" ? 1 : -1;
    const field = e.target.dataset.field;
    const tr = e.target.closest("tr");
    e.preventDefault();
    e.target.blur();
    let sib = dir > 0 ? tr.nextElementSibling : tr.previousElementSibling;
    while (sib && sib.style.display === "none") {
      sib = dir > 0 ? sib.nextElementSibling : sib.previousElementSibling;
    }
    if (sib) {
      const targetInput = sib.querySelector(`input[data-field="${field}"]`);
      if (targetInput) targetInput.focus();
    }
    return;
  }
}

function revertCell(input) {
  input.value = input.dataset.original ?? "";
  input.classList.remove("invalid");
}

// On blur: save if dirty + valid. URL field is validated via new URL();
// title must be non-empty after trim. Tags and aliases are arrays.
async function onCellBlur(e) {
  const input = e.target;
  const tr = input.closest("tr");
  const field = input.dataset.field;
  const oldVal = input.dataset.original ?? "";
  const newVal = input.value;

  // Always clear stale invalid state when starting a re-validate.
  input.classList.remove("invalid");

  // After blur logic, decide mode. We do this at the end (after async work)
  // so a server-validation failure that re-focuses doesn't get clobbered.
  const maybeEnterNormal = () => {
    if (
      !e.relatedTarget ||
      !(e.relatedTarget instanceof Element) ||
      !e.relatedTarget.matches(
        "input, textarea, [contenteditable], button",
      )
    ) {
      setMode("normal");
    }
  };

  // No change → nothing to do, but still flip mode if focus left inputs.
  if (newVal === oldVal) { maybeEnterNormal(); return; }

  // Title required (post-trim).
  if (field === "title" && newVal.trim() === "") {
    // For an existing row: revert. For a draft row (no id): allow empty —
    // the draft just stays incomplete.
    if (tr.dataset.id) {
      revertCell(input);
    }
    maybeEnterNormal();
    return;
  }

  // URL validation only when non-empty. For a real (saved) row, URL is
  // required; an empty/invalid URL keeps the cell in .invalid and does not
  // save. Draft rows can have an empty URL (no POST yet).
  if (field === "url") {
    if (newVal.trim() === "") {
      if (tr.dataset.id) {
        input.classList.add("invalid");
        maybeEnterNormal();
        return;
      }
      // Draft with empty URL — no POST yet.
      maybeEnterNormal();
      return;
    }
    if (!isValidURL(newVal.trim())) {
      input.classList.add("invalid");
      maybeEnterNormal();
      return;
    }
  }

  // Tags / aliases — no validation; just parse on send.

  // Build the payload from the row's current input values.
  const payload = readRowPayload(tr);

  // If draft (no id): POST when both title (post-trim) and url (validated) are present.
  if (!tr.dataset.id) {
    if (payload.title.trim() === "" || payload.url.trim() === "") {
      maybeEnterNormal();
      return;
    }
    if (!isValidURL(payload.url.trim())) {
      const urlInput = tr.querySelector('input[data-field="url"]');
      urlInput.classList.add("invalid");
      maybeEnterNormal();
      return;
    }
    try {
      const r = await fetch("/api/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        input.classList.add("invalid");
        maybeEnterNormal();
        return;
      }
      const created = await r.json();
      tr.dataset.id = created.id;
      // Mirror to in-memory list so subsequent operations are consistent.
      state.bookmarks.push(created);
      // Refresh all cached values so future blurs see them as "current."
      tr.querySelectorAll("input").forEach((i) => {
        i.dataset.original = i.value;
      });
      // Successful POST → undo entry. Drafts that never POST (user added a
      // row and ✕'d it before any blur) don't reach this branch, so they're
      // correctly excluded from the stack.
      state.undoStack.push({ kind: "add", id: created.id });
    } catch {
      input.classList.add("invalid");
    }
    maybeEnterNormal();
    return;
  }

  // Existing row: PUT.
  // Snapshot the FULL pre-edit bookmark BEFORE sending. Undo just re-PUTs the
  // whole snapshot — cell-level granularity isn't needed.
  const id = tr.dataset.id;
  const beforeBM = state.bookmarks.find((b) => b.id === id);
  const prev = beforeBM
    ? {
        title: beforeBM.title,
        url: beforeBM.url,
        tags: [...(beforeBM.tags || [])],
        aliases: [...(beforeBM.aliases || [])],
      }
    : null;
  try {
    const r = await fetch(
      "/api/bookmarks/" + encodeURIComponent(id),
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (!r.ok) {
      // Server rejected — restore the cell to its pre-edit value and mark
      // .invalid so the user sees the failure. No undo entry pushed.
      input.classList.add("invalid");
      revertCell(input);
      maybeEnterNormal();
      return;
    }
    // Success — make this the new "original" for future revert behavior.
    input.dataset.original = newVal;
    // Mirror to in-memory list.
    const idx = state.bookmarks.findIndex((b) => b.id === id);
    if (idx >= 0) {
      state.bookmarks[idx] = { ...state.bookmarks[idx], ...payload };
    }
    if (prev) state.undoStack.push({ kind: "edit", id, prev });
  } catch {
    input.classList.add("invalid");
  }
  maybeEnterNormal();
}

function readRowPayload(tr) {
  const get = (f) => tr.querySelector(`input[data-field="${f}"]`).value;
  return {
    title: get("title").trim(),
    url: get("url").trim(),
    tags: parseList(get("tags")),
    aliases: parseList(get("aliases")),
  };
}

function isValidURL(s) {
  try {
    const u = new URL(s);
    return Boolean(u.protocol && u.host);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Delete (two-tap mouse) — Phase A behavior, kept as-is. The vim `dd` chord
// goes through deleteCurrentRow() instead, bypassing the two-tap state.
// ---------------------------------------------------------------------------

async function onDeleteClick(e) {
  e.preventDefault();
  const tr = e.target.closest("tr");

  // First click: arm the row.
  if (!tr.classList.contains("deleting")) {
    clearPendingDelete();
    tr.classList.add("deleting");
    const timer = setTimeout(() => {
      tr.classList.remove("deleting");
      if (state.pendingDelete && state.pendingDelete.row === tr) {
        state.pendingDelete = null;
      }
    }, 2000);
    state.pendingDelete = { row: tr, timer };
    return;
  }

  // Second click within 2s: actually delete.
  clearTimeout(state.pendingDelete?.timer);
  state.pendingDelete = null;
  await deleteRow(tr);
}

function clearPendingDelete(exceptRow) {
  if (!state.pendingDelete) return;
  if (state.pendingDelete.row === exceptRow) return;
  clearTimeout(state.pendingDelete.timer);
  state.pendingDelete.row.classList.remove("deleting");
  state.pendingDelete = null;
}

document.addEventListener("click", (e) => {
  // Any click outside a row's delete button cancels pending deletes.
  if (!(e.target instanceof Element) || !e.target.closest(".del-btn")) {
    clearPendingDelete();
  }
});

// ---------------------------------------------------------------------------
// Add row — Phase A behavior preserved (top-insert via + Add button).
// ---------------------------------------------------------------------------

$addBtn.addEventListener("click", () => {
  const tr = buildRow(null);
  $rows.insertBefore(tr, $rows.firstChild);
  refreshRowIndices();
  updateCount();
  state.normalRow = 0;
  state.normalCol = 0;
  renderCursor();
  const titleInput = tr.querySelector('input[data-field="title"]');
  titleInput.focus();
});

// ---------------------------------------------------------------------------
// Filter via fzf-for-js
// ---------------------------------------------------------------------------

$filter.addEventListener("input", applyFilter);
$filter.addEventListener("focus", () => setMode("insert"));
$filter.addEventListener("blur", (e) => {
  if (
    !e.relatedTarget ||
    !(e.relatedTarget instanceof Element) ||
    !e.relatedTarget.matches("input, textarea, [contenteditable], button")
  ) {
    setMode("normal");
  }
});
$filter.addEventListener("keydown", (e) => {
  // Esc in filter: blur (preserving value) → enter normal mode via blur listener.
  if (e.key === "Escape") {
    e.preventDefault();
    $filter.blur();
  }
});

function applyFilter() {
  const q = $filter.value.trim();
  // Empty filter: show all rows.
  if (q === "") {
    [...$rows.children].forEach((tr) => (tr.style.display = ""));
    updateCount();
    clampCursorToVisible();
    renderCursor();
    return;
  }

  const F = window.fzf;
  const rows = [...$rows.children];
  const viewByRow = new Map();
  for (const tr of rows) {
    const get = (f) =>
      tr.querySelector(`input[data-field="${f}"]`)?.value ?? "";
    viewByRow.set(tr, {
      title: get("title"),
      url: get("url"),
      tags: get("tags"),
      aliases: get("aliases"),
    });
  }
  const views = rows.map((tr) => viewByRow.get(tr));

  let matchedSet;
  if (!F) {
    const ql = q.toLowerCase();
    matchedSet = new Set(
      views.filter(
        (v) =>
          v.title.toLowerCase().includes(ql) ||
          v.url.toLowerCase().includes(ql) ||
          v.tags.toLowerCase().includes(ql) ||
          v.aliases.toLowerCase().includes(ql),
      ),
    );
  } else {
    const matched = new Set();
    for (const field of FIELDS) {
      const finder = new F.Fzf(views, { selector: (v) => v[field] });
      const entries = finder.find(q);
      for (const e of entries) {
        if (e.score > 0) matched.add(e.item);
      }
    }
    matchedSet = matched;
  }

  for (const tr of rows) {
    const v = viewByRow.get(tr);
    tr.style.display = matchedSet.has(v) ? "" : "none";
  }
  updateCount();
  clampCursorToVisible();
  renderCursor();
}

function clampCursorToVisible() {
  const vis = visibleRows();
  if (vis.length === 0) {
    state.normalRow = 0;
    return;
  }
  if (state.normalRow >= vis.length) state.normalRow = vis.length - 1;
  if (state.normalRow < 0) state.normalRow = 0;
}

// ---------------------------------------------------------------------------
// Vim-chord dispatcher (normal mode)
//
// Same shape as the picker's app.js but the cursor is 2D (row, col) and
// the action set differs. Duplicated for now; can extract to a shared
// module later if it becomes painful.
// ---------------------------------------------------------------------------

const CHORD_TIMEOUT_MS = 500;
let chordBuffer = "";
let chordTimer = null;

const ACTIONS = {
  "nav-down":      () => moveCursor(0, +1),
  "nav-up":        () => moveCursor(0, -1),
  "nav-left":      () => moveCursor(-1, 0),
  "nav-right":     () => moveCursor(+1, 0),
  "nav-top":       () => setCursor(state.normalCol, 0),
  "nav-bottom":    () => setCursor(state.normalCol, visibleRows().length - 1),
  "page-down":     () => pageScrollRows(+1),
  "page-up":       () => pageScrollRows(-1),
  "edit-cell":     () => focusCurrentCell(false),
  "append-cell":   () => focusCurrentCell(true),
  "delete-row":    () => deleteCurrentRow(),
  "insert-below":  () => insertDraftRow("below"),
  "insert-above":  () => insertDraftRow("above"),
  "focus-filter":  () => $filter.focus(),
  "undo":          () => undo(),
  "show-help":     () => showHelpOverlay(),
  "goto-picker":   () => { if (window.location.pathname !== "/") window.location.href = "/"; },
  "cycle-theme":   () => cycleTheme(),
};

const KEYMAP_NORMAL = {
  "j":     "nav-down",
  "k":     "nav-up",
  "h":     "nav-left",
  "l":     "nav-right",
  "gg":    "nav-top",
  "G":     "nav-bottom",
  "Enter": "edit-cell",
  "i":     "edit-cell",
  "a":     "append-cell",
  "o":     "insert-below",
  "O":     "insert-above",
  "dd":    "delete-row",
  "u":     "undo",
  "/":     "focus-filter",
  "?":     "show-help",
  // <Space> is the leader prefix — single Space alone is unbound; bound
  // chords below.
  " p":    "goto-picker",   // <Space>p — jump to picker (/)
  " t":    "cycle-theme",   // <Space>t — cycle through built-in themes
};

function dispatchNormalKey(key, event) {
  // Playwright on Shift+letter sends lowercase + shiftKey=true; normalize.
  if (event.shiftKey) {
    if (key === "/") key = "?";
    else if (key.length === 1 && key >= "a" && key <= "z") key = key.toUpperCase();
  }

  if (chordTimer) { clearTimeout(chordTimer); chordTimer = null; }
  const next = chordBuffer + key;

  if (KEYMAP_NORMAL[next]) {
    event.preventDefault();
    chordBuffer = "";
    ACTIONS[KEYMAP_NORMAL[next]](event);
    return;
  }

  const isPrefix = Object.keys(KEYMAP_NORMAL).some(
    (k) => k.length > next.length && k.startsWith(next),
  );
  if (isPrefix) {
    event.preventDefault();
    chordBuffer = next;
    chordTimer = setTimeout(() => { chordBuffer = ""; }, CHORD_TIMEOUT_MS);
    return;
  }

  chordBuffer = "";
  if (KEYMAP_NORMAL[key]) {
    event.preventDefault();
    ACTIONS[KEYMAP_NORMAL[key]](event);
  }
}

// ---------------------------------------------------------------------------
// Global key handler (mode-aware)
// ---------------------------------------------------------------------------

document.addEventListener("keydown", (e) => {
  // Modal overlay (help, etc.) handles its own keys.
  if (document.querySelector(".modal-overlay")) return;

  // ⌘⏎ / Ctrl+⏎ — open current row's URL in new tab (both modes).
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    openCurrentRowInNewTab();
    return;
  }

  // Ctrl+D / Ctrl+U — half-page row scroll (both modes).
  if (e.ctrlKey && (e.key === "d" || e.key === "u")) {
    e.preventDefault();
    pageScrollRows(e.key === "d" ? 1 : -1);
    return;
  }

  // Any other ⌘/Ctrl-modified key falls through so browser shortcuts work.
  if (e.metaKey || e.ctrlKey) return;

  // Arrow keys in normal mode: cell navigation. In insert mode the input's
  // own keydown handler intercepts Up/Down for row-nav-same-column.
  if (state.mode === "normal") {
    if (e.key === "ArrowDown") { e.preventDefault(); moveCursor(0, +1); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); moveCursor(0, -1); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); moveCursor(-1, 0); return; }
    if (e.key === "ArrowRight"){ e.preventDefault(); moveCursor(+1, 0); return; }
  }

  // Esc: insert mode handled at element level (cell keydown reverts; filter
  // keydown blurs). Normal mode: no-op (vim-faithful).
  if (e.key === "Escape") return;

  // Normal-mode dispatch.
  if (state.mode === "normal") {
    if (e.key === "Shift" || e.key === "Meta" || e.key === "Control" || e.key === "Alt") return;
    // Enter in normal mode goes through dispatcher → edit-cell.
    if (e.key === "Enter") { dispatchNormalKey("Enter", e); return; }
    if (e.key.length === 1) {
      dispatchNormalKey(e.key, e);
    }
    return;
  }

  // Insert mode: typing falls through to the focused input. Nothing more.
});

// ---------------------------------------------------------------------------
// Help overlay
// ---------------------------------------------------------------------------

function showHelpOverlay() {
  closeModal();
  $modalRoot.innerHTML = `
    <div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div class="modal">
        <h2><span>Keyboard shortcuts</span><span class="esc">⎋ to close</span></h2>
        <div class="help-section">
          <div class="help-section-title">Insert mode (any cell or filter focused)</div>
          <dl class="help-list">
            <dt>Tab / Shift+Tab</dt><dd>cycle cells</dd>
            <dt>⎋</dt><dd>revert + normal mode</dd>
            <dt>⏎</dt><dd>save current cell, jump to next row same column</dd>
            <dt>↑ / ↓</dt><dd>save + row up/down (same column)</dd>
            <dt>⌘⏎ / Ctrl+⏎</dt><dd>open row's URL in new tab</dd>
          </dl>
        </div>
        <div class="help-section">
          <div class="help-section-title">Normal mode (no input focused)</div>
          <dl class="help-list">
            <dt>h / j / k / l</dt><dd>cell ← / row ↓ / row ↑ / cell →</dd>
            <dt>Ctrl+D / Ctrl+U</dt><dd>half-page row scroll</dd>
            <dt>gg</dt><dd>first row</dd>
            <dt>G</dt><dd>last row</dd>
            <dt>i / ⏎</dt><dd>edit current cell</dd>
            <dt>a</dt><dd>edit, cursor at end</dd>
            <dt>o / O</dt><dd>new row below / above</dd>
            <dt>dd</dt><dd>delete current row</dd>
            <dt>u</dt><dd>undo last add/edit/delete</dd>
            <dt>/</dt><dd>focus filter</dd>
            <dt>?</dt><dd>this help</dd>
            <dt>&lt;Space&gt;p</dt><dd>jump to picker (/)</dd>
            <dt>&lt;Space&gt;t</dt><dd>cycle theme</dd>
          </dl>
        </div>
        <div class="modal-footer">
          <span>⎋ close</span>
          <div class="actions">
            <button id="m-close" class="btn btn-primary">Close</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.getElementById("m-close").addEventListener("click", closeModal);
  $modalRoot.querySelector(".modal").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeModal(); return; }
  });
  document.getElementById("m-close").focus();
}

function closeModal() {
  $modalRoot.innerHTML = "";
  // After closing, leave focus on the page body so we stay in normal mode.
  // (Don't auto-focus the filter — picker's flow is different.)
}

// ---------------------------------------------------------------------------
// Undo (vim `u` in normal mode)
//
// One entry per `u` press. Silent — the reappearing / disappearing /
// reverting row IS the feedback. On failure (e.g. user over-undid into a
// deleted-then-restored bookmark whose id is stale), surface and stop;
// don't auto-recover.
// ---------------------------------------------------------------------------
async function undo() {
  if (state.undoStack.length === 0) return; // silent no-op
  const entry = state.undoStack.pop();
  try {
    if (entry.kind === "delete") {
      const r = await fetch("/api/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry.prev),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } else if (entry.kind === "edit") {
      const r = await fetch("/api/bookmarks/" + encodeURIComponent(entry.id), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry.prev),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } else if (entry.kind === "add") {
      const r = await fetch("/api/bookmarks/" + encodeURIComponent(entry.id), {
        method: "DELETE",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    }
    await load();
  } catch (err) {
    alert("undo failed: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

load();
