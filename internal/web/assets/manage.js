// snackpage manage view — Phase A (basic CRUD spreadsheet).
//
// Vanilla JS, module-scoped. Renders all bookmarks as a table of editable
// <input> cells. PUT on blur, Esc reverts, Enter saves+moves down.
//
// Phase B (TBD) will layer on vim-modal cell navigation (j/k/h/l/gg/G/dd/o/O).

const FIELDS = ["title", "url", "tags", "aliases"];

const state = {
  bookmarks: [], // server payload
  pendingDelete: null, // { row, timer } — for two-tap delete
};

const $filter = document.getElementById("filter");
const $rows = document.getElementById("rows");
const $rowCount = document.getElementById("row-count");
const $addBtn = document.getElementById("add-btn");

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
  updateCount();
}

function updateCount() {
  const total = $rows.children.length;
  const visible = [...$rows.children].filter(
    (tr) => tr.style.display !== "none",
  ).length;
  $rowCount.textContent =
    total === visible ? `${total} rows` : `${visible} / ${total} rows`;
}

// Build a <tr> for a bookmark. If b is null/undefined, the row is a draft
// (no data-id; POST on first valid blur).
function buildRow(b) {
  const tr = document.createElement("tr");
  if (b && b.id) tr.dataset.id = b.id;
  tr.innerHTML = `
    <td class="cell col-title"><input type="text" data-field="title" value="${escapeHTML(b?.title ?? "")}"></td>
    <td class="cell col-url"><input type="text" data-field="url" value="${escapeHTML(b?.url ?? "")}"></td>
    <td class="cell col-tags"><input type="text" data-field="tags" value="${escapeHTML(formatList(b?.tags))}"></td>
    <td class="cell col-aliases"><input type="text" data-field="aliases" value="${escapeHTML(formatList(b?.aliases))}"></td>
    <td class="col-del"><button type="button" class="del-btn" aria-label="delete">✕</button></td>
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
  });
  const delBtn = tr.querySelector(".del-btn");
  delBtn.addEventListener("click", onDeleteClick);
}

// ---------------------------------------------------------------------------
// Cell editing
// ---------------------------------------------------------------------------

function onCellFocus(e) {
  // Stash the value so Esc can revert.
  e.target.dataset.original = e.target.value;
  // Any focus change cancels a pending delete on another row.
  clearPendingDelete(e.target.closest("tr"));
}

function onCellKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    revertCell(e.target);
    e.target.blur();
    return;
  }
  if (e.key === "Enter") {
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

  // No change → nothing to do.
  if (newVal === oldVal) return;

  // Title required (post-trim).
  if (field === "title" && newVal.trim() === "") {
    // For an existing row: revert. For a draft row (no id): allow empty —
    // the draft just stays incomplete.
    if (tr.dataset.id) {
      revertCell(input);
    }
    return;
  }

  // URL validation only when non-empty. For a real (saved) row, URL is
  // required; an empty/invalid URL keeps the cell in .invalid and does not
  // save. Draft rows can have an empty URL (no POST yet).
  if (field === "url") {
    if (newVal.trim() === "") {
      if (tr.dataset.id) {
        input.classList.add("invalid");
        return;
      }
      // Draft with empty URL — no POST yet.
      return;
    }
    if (!isValidURL(newVal.trim())) {
      input.classList.add("invalid");
      return;
    }
  }

  // Tags / aliases — no validation; just parse on send.

  // Build the payload from the row's current input values.
  const payload = readRowPayload(tr);

  // If draft (no id): POST when both title (post-trim) and url (validated) are present.
  if (!tr.dataset.id) {
    if (payload.title.trim() === "" || payload.url.trim() === "") return;
    if (!isValidURL(payload.url.trim())) {
      const urlInput = tr.querySelector('input[data-field="url"]');
      urlInput.classList.add("invalid");
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
        return;
      }
      const created = await r.json();
      tr.dataset.id = created.id;
      // Refresh all cached values so future blurs see them as "current."
      tr.querySelectorAll("input").forEach((i) => {
        i.dataset.original = i.value;
      });
    } catch {
      input.classList.add("invalid");
    }
    return;
  }

  // Existing row: PUT.
  try {
    const r = await fetch(
      "/api/bookmarks/" + encodeURIComponent(tr.dataset.id),
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    if (!r.ok) {
      // Server rejected — restore the cell to its pre-edit value and mark
      // .invalid so the user sees the failure.
      input.classList.add("invalid");
      revertCell(input);
      return;
    }
    // Success — make this the new "original" for future revert behavior.
    input.dataset.original = newVal;
  } catch {
    input.classList.add("invalid");
  }
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
    // Require a scheme that looks like a real protocol (http, https, …).
    // new URL("foo:bar") technically parses; reject if no host AND scheme
    // isn't well-known. The server uses net/url.Parse which is more lax,
    // but on the wire we want http/https/etc.
    return Boolean(u.protocol && u.host);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Delete (two-tap)
// ---------------------------------------------------------------------------

async function onDeleteClick(e) {
  e.preventDefault();
  const tr = e.target.closest("tr");

  // First click: arm the row.
  if (!tr.classList.contains("deleting")) {
    clearPendingDelete(); // cancel any other pending delete
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

  // Draft row (no id): just remove from DOM.
  if (!tr.dataset.id) {
    tr.remove();
    updateCount();
    return;
  }

  try {
    const r = await fetch(
      "/api/bookmarks/" + encodeURIComponent(tr.dataset.id),
      { method: "DELETE" },
    );
    if (!r.ok && r.status !== 404) {
      tr.classList.remove("deleting");
      return;
    }
    tr.remove();
    updateCount();
  } catch {
    tr.classList.remove("deleting");
  }
}

// Clear any pending delete that isn't on `exceptRow`. Called on any focus
// change so a single click on ✕ followed by clicking elsewhere is safe.
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
// Add row
// ---------------------------------------------------------------------------

$addBtn.addEventListener("click", () => {
  const tr = buildRow(null);
  $rows.insertBefore(tr, $rows.firstChild);
  updateCount();
  const titleInput = tr.querySelector('input[data-field="title"]');
  titleInput.focus();
});

// ---------------------------------------------------------------------------
// Filter via fzf-for-js
// ---------------------------------------------------------------------------

$filter.addEventListener("input", applyFilter);

function applyFilter() {
  const q = $filter.value.trim();
  // Empty filter: show all rows. Different from picker (which hides all).
  if (q === "") {
    [...$rows.children].forEach((tr) => (tr.style.display = ""));
    updateCount();
    return;
  }

  const F = window.fzf;
  // Build a per-row "view" snapshot from the live DOM so in-flight edits
  // also participate in filtering.
  const rows = [...$rows.children];
  const viewByRow = new Map(); // tr -> { title, url, tags, aliases }
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
    // Substring fallback.
    const ql = q.toLowerCase();
    matchedSet = new Set(
      views
        .filter(
          (v) =>
            v.title.toLowerCase().includes(ql) ||
            v.url.toLowerCase().includes(ql) ||
            v.tags.toLowerCase().includes(ql) ||
            v.aliases.toLowerCase().includes(ql),
        )
        .map((v) => v),
    );
  } else {
    // fzf-for-js: one finder per field; union of nonzero-score rows.
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
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

load();
