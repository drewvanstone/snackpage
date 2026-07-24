// snackpage manage view — Phase B (vim-modal spreadsheet).
//
// Layered on top of Phase A's CRUD-on-blur spreadsheet, this adds a
// vim-style modal editor: insert mode (any cell or filter input focused)
// behaves like Phase A; normal mode (no input focused) gets vim chord
// navigation (hjkl/gg/G/dd/o/O/i/a/⏎/⌘⏎/?). Mode is driven by input
// focus/blur — Esc inside a cell reverts (Phase A) and then blurs into
// normal mode automatically.

import { openThemePicker } from "./theme.js";

const FIELDS = ["title", "url", "tags", "aliases"];
const MAX_COL = FIELDS.length - 1; // 0..3

const state = {
  bookmarks: [],            // server payload (raw rows)
  pendingDelete: null,      // { row, timer } — for two-tap mouse delete (Phase A)
  mode: "insert",           // "insert" | "normal"
  normalRow: 0,             // index into the currently visible row set
  normalCol: 0,             // 0..MAX_COL
  mutationBlocked: false,
  mutationInFlight: false,
  // In-memory undo stack — same shape as the picker's. Per-view; refreshing
  // /manage or hopping to the picker clears it.
  //   { kind: "add",    id }
  //   { kind: "edit",   id, prev: {title,url,tags,aliases} }
  //   { kind: "delete", id, prev: {title,url,tags,aliases} }
  undoStack: [],
};
const rowQueues = new WeakMap();
const pendingRowMutations = new Set();
let manageMutationTail = Promise.resolve();

const $managePage = document.getElementById("manage");
const $filter = document.getElementById("filter");
const $rows = document.getElementById("rows");
const $rowCount = document.getElementById("row-count");
const $addBtn = document.getElementById("add-btn");
const $hints = document.getElementById("hints");
const $modalRoot = document.getElementById("modal-root");
const $tableWrap = document.querySelector(".manage-table-wrap");
const $status = document.getElementById("status");

const HINTS = {
  insert:
    "Tab nav · ⎋ revert + normal · ⏎ save+down · ⌘⏎ open in new tab",
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

function normalizeURL(value) {
  const trimmed = value.trim();
  return trimmed && !trimmed.includes("://") ? `https://${trimmed}` : trimmed;
}

function setStatus(message = "", isError = false) {
  $status.textContent = message;
  $status.hidden = message === "";
  $status.classList.toggle("error", isError);
}

async function apiFetch(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (cause) {
    const method = String(options.method || "GET").toUpperCase();
    if (["POST", "PUT", "DELETE"].includes(method)) {
      const error = new Error(
        "Connection lost while saving. Outcome unknown; reload before retrying.",
        { cause },
      );
      error.unknownOutcome = true;
      throw error;
    }
    throw cause;
  }
  const body = response.status === 204
    ? null
    : await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error || `HTTP ${response.status}`);
  }
  return body;
}

function requireBookmark(body) {
  if (
    !body ||
    typeof body !== "object" ||
    typeof body.id !== "string" ||
    body.id === "" ||
    typeof body.title !== "string" ||
    typeof body.url !== "string"
  ) {
    const error = new Error(
      "The server accepted the request but returned an unreadable response. " +
      "Outcome unknown; reload before retrying.",
    );
    error.unknownOutcome = true;
    throw error;
  }
  return body;
}

function blockRowAfterUnknownOutcome(tr) {
  tr.dataset.outcomeUnknown = "true";
  for (const input of tr.querySelectorAll("input")) input.readOnly = true;
  const deleteButton = tr.querySelector(".del-btn");
  if (deleteButton) deleteButton.disabled = true;
}

function setManageMutationControlsLocked(locked) {
  const globallyLocked = locked || state.mutationBlocked;
  for (const tr of $rows.querySelectorAll("tr")) {
    const rowLocked =
      globallyLocked || tr.dataset.outcomeUnknown === "true";
    for (const input of tr.querySelectorAll("input")) {
      input.readOnly = rowLocked;
    }
    const deleteButton = tr.querySelector(".del-btn");
    if (deleteButton) deleteButton.disabled = rowLocked;
  }
  $addBtn.disabled = globallyLocked;
}

function blockManageMutations(message) {
  state.mutationBlocked = true;
  setManageMutationControlsLocked(true);
  setStatus(message, true);
}

function manageMutationsAllowed() {
  if (!state.mutationBlocked) return true;
  setStatus(
    "A previous mutation has an unknown outcome; reload before making more changes.",
    true,
  );
  return false;
}

function blockUnknownMutation(tr, message) {
  blockRowAfterUnknownOutcome(tr);
  blockManageMutations(message);
}

async function runManageMutation(task) {
  if (!manageMutationsAllowed() || state.mutationInFlight) return false;
  state.mutationInFlight = true;
  // An undo reload replaces every row node. Lock editing for the whole
  // explicit action so a blur cannot queue work against a node that the
  // action is about to disconnect. This also makes the busy state visible.
  setManageMutationControlsLocked(true);
  try {
    // Blur saves are queued too. Let every already-observed edit settle
    // before an explicit add/delete/undo action enters the same scheduler.
    await drainRowMutations();
    if (!manageMutationsAllowed()) return false;
    await scheduleManageMutation(task);
    return true;
  } finally {
    state.mutationInFlight = false;
    setManageMutationControlsLocked(false);
  }
}

function scheduleManageMutation(task) {
  const operation = manageMutationTail.then(() => {
    if (!manageMutationsAllowed()) {
      const error = new Error(
        "A previous mutation has an unknown outcome; reload before retrying.",
      );
      error.unknownOutcome = true;
      throw error;
    }
    return task();
  });
  // Keep the scheduler usable after a known failure while returning the
  // original rejecting promise to the caller that owns the error UI.
  manageMutationTail = operation.catch(() => {});
  return operation;
}

// ---------------------------------------------------------------------------
// Initial load + render
// ---------------------------------------------------------------------------

async function load() {
  try {
    const json = await apiFetch("/api/bookmarks");
    if (!Array.isArray(json?.bookmarks)) {
      throw new Error("server returned an invalid bookmark list");
    }
    state.bookmarks = json.bookmarks;
    renderAll();
    setStatus();
  } catch (error) {
    setStatus(`Could not load bookmarks: ${error.message}`, true);
  }
}

function renderAll() {
  $rows.innerHTML = "";
  for (const b of state.bookmarks) {
    $rows.appendChild(buildRow(b));
  }
  refreshRowIndices();
  applyFilter();
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
    <td class="cell col-title" data-col-index="0"><input type="text" aria-label="Title" data-field="title" data-col-index="0" value="${escapeHTML(b?.title ?? "")}"></td>
    <td class="cell col-url" data-col-index="1"><input type="text" aria-label="URL" data-field="url" data-col-index="1" value="${escapeHTML(b?.url ?? "")}"></td>
    <td class="cell col-tags" data-col-index="2"><input type="text" aria-label="Tags" data-field="tags" data-col-index="2" value="${escapeHTML(formatList(b?.tags))}"></td>
    <td class="cell col-aliases" data-col-index="3"><input type="text" aria-label="Aliases" data-field="aliases" data-col-index="3" value="${escapeHTML(formatList(b?.aliases))}"></td>
    <td class="col-del"><button type="button" class="del-btn" aria-label="Delete ${escapeHTML(b?.title || "draft bookmark")}">✕</button></td>
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
  window.open(normalizeURL(url), "_blank", "noopener");
}

// Re-index visible rows in the DOM order. Call after add/delete/filter.
function refreshRowIndices() {
  const rows = [...$rows.children];
  rows.forEach((tr, i) => { tr.dataset.rowIndex = String(i); });
}

function visibleRows() {
  return [...$rows.children].filter((tr) => !tr.hidden);
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
  return deleteRow(tr);
}

async function deleteRow(tr) {
  if (!manageMutationsAllowed()) return;
  // Clear any in-flight two-tap state — chord IS the confirmation.
  clearPendingDelete();

  // runManageMutation drains row saves before scheduling this delete. A
  // later blur is placed behind the delete and becomes a no-op once the row
  // is disconnected.
  if (tr.dataset.outcomeUnknown === "true") {
    setStatus(
      "This row has a save with an unknown outcome; reload before deleting it.",
      true,
    );
    return;
  }

  // Draft row (no id): just remove from DOM.
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
    await apiFetch(
      "/api/bookmarks/" + encodeURIComponent(id),
      { method: "DELETE" },
    );
    state.bookmarks = state.bookmarks.filter((b) => b.id !== id);
    tr.remove();
    refreshRowIndices();
    applyFilter();
    renderCursor();
    if (prev) state.undoStack.push({ kind: "delete", id, prev });
    setStatus();
  } catch (error) {
    if (error.unknownOutcome) blockUnknownMutation(tr, error.message);
    setStatus(`Delete failed: ${error.message}`, true);
  }
}

// Insert a fresh draft row above or below the current row (or at the top
// if there is no current row). Focuses the new row's title cell, which
// transitions us into insert mode via the focus listener.
function insertDraftRow(where) {
  if (!manageMutationsAllowed()) return;
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
  window.open(normalizeURL(url), "_blank", "noopener");
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
    while (next && next.hidden) next = next.nextElementSibling;
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
    while (sib && sib.hidden) {
      sib = dir > 0 ? sib.nextElementSibling : sib.previousElementSibling;
    }
    if (sib) {
      const targetInput = sib.querySelector(`input[data-field="${field}"]`);
      if (targetInput) targetInput.focus();
    }
    return;
  }
}

function revertCell(input, markInvalid = false) {
  input.value = input.dataset.original ?? "";
  input.classList.toggle("invalid", markInvalid);
}

function isEditingControl(element) {
  return (
    element instanceof Element &&
    (element === $filter || element.matches("#rows input"))
  );
}

document.addEventListener("focusin", () => {
  setMode(isEditingControl(document.activeElement) ? "insert" : "normal");
});
document.addEventListener("focusout", (event) => {
  // relatedTarget is the element receiving focus. Reading it here avoids an
  // async blur save later overwriting the mode established by a new focus.
  setMode(isEditingControl(event.relatedTarget) ? "insert" : "normal");
});

function enqueueRowMutation(tr, work) {
  const prior = rowQueues.get(tr) || Promise.resolve();
  const operation = prior.then(() => scheduleManageMutation(work));
  const settled = operation.catch((error) => {
    // Block before resolving the queue tail, so already-enqueued operations
    // observe the unknown state and cannot issue a duplicate POST/PUT.
    if (error.unknownOutcome) blockUnknownMutation(tr, error.message);
  });
  rowQueues.set(tr, settled);
  pendingRowMutations.add(settled);
  settled.finally(() => {
    pendingRowMutations.delete(settled);
    if (rowQueues.get(tr) === settled) rowQueues.delete(tr);
  });
  return operation;
}

async function drainRowMutations() {
  while (pendingRowMutations.size > 0) {
    await Promise.all([...pendingRowMutations]);
  }
}

function bookmarkPayload(bookmark) {
  return {
    title: bookmark.title,
    url: bookmark.url,
    tags: [...(bookmark.tags || [])],
    aliases: [...(bookmark.aliases || [])],
  };
}

function samePayload(left, right) {
  return (
    left.title === right.title &&
    left.url === right.url &&
    JSON.stringify(left.tags || []) === JSON.stringify(right.tags || []) &&
    JSON.stringify(left.aliases || []) === JSON.stringify(right.aliases || [])
  );
}

function displayValue(field, bookmark) {
  return field === "tags" || field === "aliases"
    ? formatList(bookmark[field])
    : bookmark[field] || "";
}

function applyServerBookmark(tr, bookmark, sent) {
  for (const input of tr.querySelectorAll("input[data-field]")) {
    const field = input.dataset.field;
    const sentValue = field === "tags" || field === "aliases"
      ? formatList(sent[field])
      : sent[field];
    // Do not overwrite typing that happened while this request was in flight.
    if (input.value === sentValue) {
      const serverValue = displayValue(field, bookmark);
      input.value = serverValue;
      input.dataset.original = serverValue;
      input.classList.remove("invalid");
    }
  }
  const deleteButton = tr.querySelector(".del-btn");
  if (deleteButton) deleteButton.setAttribute("aria-label", `Delete ${bookmark.title}`);
}

async function persistRow(tr, payload) {
  if (!tr.isConnected) return;
  if (state.mutationBlocked || tr.dataset.outcomeUnknown === "true") {
    const error = new Error(
      "A previous mutation has an unknown outcome; reload before retrying.",
    );
    error.unknownOutcome = true;
    throw error;
  }

  const existingId = tr.dataset.id;
  if (!existingId) {
    const created = requireBookmark(await apiFetch("/api/bookmarks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }));
    tr.dataset.id = created.id;
    state.bookmarks.push(created);
    applyServerBookmark(tr, created, payload);
    state.undoStack.push({ kind: "add", id: created.id });
  } else {
    const before = state.bookmarks.find((bookmark) => bookmark.id === existingId);
    if (before && samePayload(bookmarkPayload(before), payload)) {
      applyServerBookmark(tr, before, payload);
      return;
    }
    const prev = before ? bookmarkPayload(before) : null;
    const updated = requireBookmark(await apiFetch(
      "/api/bookmarks/" + encodeURIComponent(existingId),
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    ));
    const index = state.bookmarks.findIndex((bookmark) => bookmark.id === existingId);
    if (index >= 0) state.bookmarks[index] = updated;
    applyServerBookmark(tr, updated, payload);
    if (prev) state.undoStack.push({ kind: "edit", id: existingId, prev });
  }

  applyFilter();
  setStatus();
}

// Validate synchronously on blur, then enqueue the row mutation. A row has a
// single promise chain, so rapid Tab/Enter navigation cannot reorder PUTs or
// issue duplicate POSTs for a draft.
function onCellBlur(e) {
  const input = e.target;
  const tr = input.closest("tr");
  const field = input.dataset.field;
  const oldVal = input.dataset.original ?? "";
  if (!manageMutationsAllowed()) return;
  if (field === "url") input.value = normalizeURL(input.value);
  const newVal = input.value;

  input.classList.remove("invalid");
  if (newVal === oldVal) return;

  if (field === "title" && newVal.trim() === "") {
    if (tr.dataset.id) {
      input.classList.add("invalid");
      setStatus("Title is required; the row was not saved.", true);
    }
    return;
  }

  if (field === "url") {
    if (newVal.trim() === "") {
      if (tr.dataset.id) {
        input.classList.add("invalid");
        setStatus("URL is required; the row was not saved.", true);
      }
      return;
    }
    if (!isValidURL(newVal.trim())) {
      input.classList.add("invalid");
      setStatus("Enter a URL with a scheme and host.", true);
      return;
    }
  }

  const payload = readRowPayload(tr);
  payload.url = normalizeURL(payload.url);

  if (!tr.dataset.id) {
    if (payload.title.trim() === "" || payload.url.trim() === "") return;
    if (!isValidURL(payload.url.trim())) {
      const urlInput = tr.querySelector('input[data-field="url"]');
      urlInput.classList.add("invalid");
      setStatus("Enter a URL with a scheme and host.", true);
      return;
    }
  }

  void enqueueRowMutation(tr, () => persistRow(tr, payload)).catch((error) => {
    if (!input.isConnected) return;
    input.classList.add("invalid");
    if (error.unknownOutcome) {
      blockUnknownMutation(tr, error.message);
    }
    setStatus(`Save failed: ${error.message}`, true);
  });
}

function readRowPayload(tr) {
  const get = (f) => tr.querySelector(`input[data-field="${f}"]`).value;
  return {
    title: get("title").trim(),
    url: normalizeURL(get("url")),
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
  try {
    await runManageMutation(() => deleteRow(tr));
  } finally {
    // A known failure or a scheduler rejection must require a fresh
    // confirmation. Never leave the row visually/behaviorally armed.
    tr.classList.remove("deleting");
  }
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
  void runManageMutation(() => {
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
});

// ---------------------------------------------------------------------------
// Filter via fzf-for-js
// ---------------------------------------------------------------------------

$filter.addEventListener("input", applyFilter);
$filter.addEventListener("keydown", (e) => {
  // Esc in filter: blur (preserving value) and enter normal mode.
  if (e.key === "Escape") {
    e.preventDefault();
    $filter.blur();
  }
});

function applyFilter() {
  const q = $filter.value.trim();
  // Empty filter: show all rows.
  if (q === "") {
    [...$rows.children].forEach((tr) => { tr.hidden = false; });
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
    tr.hidden = !matchedSet.has(v);
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
  "delete-row":    () => runManageMutation(deleteCurrentRow),
  "insert-below":  () => runManageMutation(() => insertDraftRow("below")),
  "insert-above":  () => runManageMutation(() => insertDraftRow("above")),
  "focus-filter":  () => $filter.focus(),
  "undo":          () => runManageMutation(undo),
  "show-help":     () => showHelpOverlay(),
  "goto-picker":   () => { if (window.location.pathname !== "/") window.location.href = "/"; },
  "open-theme-picker": () => openThemePicker(),
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
  " t":    "open-theme-picker",   // <Space>t — open theme picker overlay
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
  if (
    e.target instanceof Element &&
    e.target.closest("a, button, select, textarea, [contenteditable='true']")
  ) {
    return;
  }

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

let modalReturnFocus = null;

function showHelpOverlay() {
  modalReturnFocus = document.activeElement;
  $modalRoot.innerHTML = `
    <div class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="manage-help-title">
      <div class="modal" tabindex="-1">
        <h2 id="manage-help-title"><span>Keyboard shortcuts</span><span class="esc">⎋ to close</span></h2>
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
            <dt>&lt;Space&gt;t</dt><dd>pick theme</dd>
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
    if (e.key === "Tab") {
      e.preventDefault();
      document.getElementById("m-close").focus();
    }
  });
  document.getElementById("m-close").focus();
}

function closeModal() {
  $modalRoot.innerHTML = "";
  const returnFocus = modalReturnFocus;
  modalReturnFocus = null;
  if (returnFocus instanceof HTMLElement && returnFocus.isConnected) {
    returnFocus.focus();
  }
}

// ---------------------------------------------------------------------------
// Undo (vim `u` in normal mode)
//
// ---------------------------------------------------------------------------
function rekeyUndoReferences(oldId, newId) {
  for (const item of state.undoStack) {
    if (item.id === oldId) item.id = newId;
  }
}

async function undo() {
  if (!manageMutationsAllowed()) return;
  if (state.undoStack.length === 0) return;
  const entry = state.undoStack.pop();
  try {
    if (entry.kind === "delete") {
      const restored = requireBookmark(await apiFetch("/api/bookmarks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry.prev),
      }));
      rekeyUndoReferences(entry.id, restored.id);
    } else if (entry.kind === "edit") {
      requireBookmark(await apiFetch("/api/bookmarks/" + encodeURIComponent(entry.id), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry.prev),
      }));
    } else if (entry.kind === "add") {
      await apiFetch("/api/bookmarks/" + encodeURIComponent(entry.id), {
        method: "DELETE",
      });
    }
    await load();
  } catch (err) {
    if (err.unknownOutcome) {
      blockManageMutations(`Undo failed: ${err.message}`);
    } else {
      state.undoStack.push(entry);
      setStatus(`Undo failed: ${err.message}`, true);
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function reconcileManageMode({ requestDefaultFocus = false } = {}) {
  const active = document.activeElement;
  if (
    requestDefaultFocus &&
    (active === document.body || active === document.documentElement)
  ) {
    // Autofocus is only a hint. Attempt it once, then reflect the focus the
    // browser actually granted so keyboard input never lands in a phantom
    // insert mode.
    $filter.focus({ preventScroll: true });
  }
  setMode(isEditingControl(document.activeElement) ? "insert" : "normal");
}

load();
reconcileManageMode({ requestDefaultFocus: true });
window.addEventListener("pageshow", () => reconcileManageMode());
