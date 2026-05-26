// snackpage frontend. Vanilla JS, no build step.
// Public surface: nothing — everything is module-scoped.

import { cycleTheme } from "./theme.js";

const state = {
  bookmarks: [],   // [{id,title,url,tags,aliases,visit_count,last_visit_at}]
  view: [],        // filtered + sorted subset rendered to DOM
  selected: 0,     // index into view
  mode: "insert",  // "insert" | "normal" — vim-style modal editor mode
  // In-memory undo stack. One entry per successful add / edit / delete.
  // Per-view: refreshing the page or switching to /manage clears it.
  // Entry shapes:
  //   { kind: "add",    id }                              — undo POSTed bookmark
  //   { kind: "edit",   id, prev: {title,url,tags,aliases} } — restore pre-edit
  //   { kind: "delete", prev: {title,url,tags,aliases} }   — re-POST (NEW id)
  undoStack: [],
};

const $q = document.getElementById("q");
const $list = document.getElementById("list");
const $count = document.getElementById("count");
const $picker = document.getElementById("picker");
const $hints = document.getElementById("hints");

// Footer hints text per mode. The visible affordance should match what the
// keyboard actually does: in insert you press ⎋ to leave to normal; in
// normal you press i/a/ to return to insert, j/k navigates, and the
// vim chords a/e/dd handle the app commands.
const HINTS = {
  insert: "↑↓ select · ⏎ open · ⎋ normal mode · ? help",
  normal: "j/k select · ⏎ open · a add · e edit · dd delete · i insert mode · ? help",
};

function setMode(m) {
  state.mode = m;
  if ($picker) $picker.setAttribute("data-mode", m);
  if ($hints) $hints.textContent = HINTS[m];
}

// Mode follows the input's focus state: focused = insert, blurred = normal.
$q.addEventListener("focus", () => setMode("insert"));
$q.addEventListener("blur", () => setMode("normal"));

async function load() {
  const r = await fetch("/api/bookmarks");
  const j = await r.json();
  state.bookmarks = j.bookmarks || [];
  refresh();
}

function refresh() {
  const q = $q.value.trim();
  if (q === "") {
    state.view = [];
  } else {
    state.view = fuzzyRank(q, state.bookmarks);
  }
  if (state.selected >= state.view.length) state.selected = Math.max(0, state.view.length - 1);
  if (state.view.length > 0 && state.selected < 0) state.selected = 0;
  render();
}

// Weighted fzf ranking. Falls back to substring match if fzf failed to load.
function fuzzyRank(q, items) {
  const F = window.fzf;
  if (!F) {
    const ql = q.toLowerCase();
    return items.filter(b =>
      b.title.toLowerCase().includes(ql) ||
      b.url.toLowerCase().includes(ql) ||
      (b.tags || []).some(t => t.toLowerCase().includes(ql)) ||
      (b.aliases || []).some(a => a.toLowerCase().includes(ql))
    );
  }
  // fzf-for-js: build a Fzf finder per field, score, sum.
  const titleFinder = new F.Fzf(items, { selector: i => i.title });
  const urlFinder = new F.Fzf(items, { selector: i => i.url });
  const tagsFinder = new F.Fzf(items, { selector: i => (i.tags || []).join(" ") });
  const aliasFinder = new F.Fzf(items, { selector: i => (i.aliases || []).join(" ") });

  const scoreMap = new Map(); // id -> { score, item }
  function feed(finder, weight) {
    const entries = finder.find(q);
    for (const e of entries) {
      const cur = scoreMap.get(e.item.id) || { score: 0, item: e.item };
      cur.score += weight * e.score;
      scoreMap.set(e.item.id, cur);
    }
  }
  feed(titleFinder, 4);
  feed(aliasFinder, 3);
  feed(tagsFinder, 2);
  feed(urlFinder, 1);

  const now = Date.now();
  const ranked = [...scoreMap.values()].map(({ score, item }) => ({
    item,
    score: score + 0.001 * frecency(item, now),
  }));
  ranked.sort((a, z) => z.score - a.score);
  return ranked.map(r => r.item);
}

function frecency(b, now) {
  const last = b.last_visit_at ? new Date(b.last_visit_at).getTime() : 0;
  const visits = b.visit_count || 0;
  let decay;
  if (!last) {
    decay = 0.1;
  } else {
    const days = Math.floor((now - last) / 86_400_000);
    if (days <= 1) decay = 1.0;
    else if (days <= 7) decay = 0.6;
    else if (days <= 30) decay = 0.3;
    else decay = 0.1;
  }
  return Math.max(visits, 1) * decay;
}

function relTime(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

function render() {
  $list.innerHTML = "";
  state.view.forEach((b, i) => {
    const li = document.createElement("li");
    li.className = "row";
    li.setAttribute("aria-selected", i === state.selected ? "true" : "false");
    li.dataset.id = b.id;
    // Tags are wrapped in <span class="tag"> so themes can restyle them
    // (e.g. classic-mac renders bordered chiclets). The "·" separator stays
    // outside the spans so it's not styled with them.
    const tagsHTML = b.tags && b.tags.length
      ? "  ·  " + b.tags.map((t) => `<span class="tag">${escapeHTML(t)}</span>`).join(" ")
      : "";
    li.innerHTML = `
      <span class="marker">▌</span>
      <div>
        <div class="title">${escapeHTML(b.title)}</div>
        <div class="sub">${escapeHTML(b.url)}${tagsHTML}</div>
      </div>
      <div class="meta">${relTime(b.last_visit_at)}<span class="count">${b.visit_count || 0} visits</span></div>
    `;
    $list.appendChild(li);
  });
  $count.textContent = `${state.view.length} / ${state.bookmarks.length}`;
}

$q.addEventListener("input", refresh);

function scrollSelectedIntoView() {
  const sel = $list.querySelector('[aria-selected="true"]');
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

function move(delta) {
  if (state.view.length === 0) return;
  state.selected = (state.selected + delta + state.view.length) % state.view.length;
  render();
  scrollSelectedIntoView();
}

// Half-page scroll, vim's Ctrl+D / Ctrl+U. Move selection by half the
// currently visible row count, clamped at the list edges (no wrap).
function pageScroll(direction) {
  if (state.view.length === 0) return;
  const firstRow = $list.querySelector("li");
  if (!firstRow) return;
  const rowH = firstRow.offsetHeight || 1;
  const halfVisible = Math.max(1, Math.floor($list.clientHeight / rowH / 2));
  state.selected = Math.max(
    0,
    Math.min(state.view.length - 1, state.selected + direction * halfVisible),
  );
  render();
  scrollSelectedIntoView();
}

function openSelected(newTab) {
  const b = state.view[state.selected];
  if (!b) return;
  const url = "/go/" + encodeURIComponent(b.id);
  if (newTab) window.open(url, "_blank");
  else window.location.href = url;
}

// --------------------------------------------------------------------------
// Vim-chord dispatch (normal mode)
//
// Picker commands map to named actions (ACTIONS). The active keymap
// (KEYMAP_NORMAL) maps key sequences → action names. Single-key entries fire
// immediately when no other binding shares the prefix; multi-key entries
// (e.g. "gg", "dd") wait CHORD_TIMEOUT_MS for the next key.
//
// The named-action seam is intentional: v3 keymap customization will load
// $XDG_CONFIG_HOME/snackpage/keymap.json and merge it over KEYMAP_NORMAL
// before the dispatcher sees it. Action handlers stay the same.
// --------------------------------------------------------------------------

const CHORD_TIMEOUT_MS = 500;
let chordBuffer = "";
let chordTimer = null;

const ACTIONS = {
  "nav-down":      () => move(1),
  "nav-up":        () => move(-1),
  "nav-top":       () => {
    if (state.view.length) { state.selected = 0; render(); scrollSelectedIntoView(); }
  },
  "nav-bottom":    () => {
    if (state.view.length) { state.selected = state.view.length - 1; render(); scrollSelectedIntoView(); }
  },
  "open":          () => openSelected(false),
  "open-new-tab":  () => openSelected(true),
  "enter-insert":  () => {
    $q.focus();
    const len = $q.value.length;
    $q.setSelectionRange(len, len);
  },
  "add":           () => openModal({ title: "Add bookmark", onSave: createBookmark }),
  "edit":          () => {
    const b = state.view[state.selected];
    if (!b) return;
    openModal({
      title: "Edit bookmark",
      initial: b,
      onSave: (payload) => updateBookmark(b.id, payload),
    });
  },
  "delete":        () => {
    const b = state.view[state.selected];
    if (!b) return;
    deleteBookmark(b.id).catch((err) => alert("delete failed: " + err.message));
  },
  "undo":          () => undo(),
  "show-help":     () => showHelpOverlay(),
  "goto-manage":   () => { if (window.location.pathname !== "/manage") window.location.href = "/manage"; },
  "cycle-theme":   () => cycleTheme(),
};

// Default keymap (picker, normal mode). Maps key-sequence strings → action
// names. Multi-key chords require their prefix not be bound on its own;
// e.g. "gg" requires "g" not appear as a single-key entry, same for "dd".
//
// Notes:
//   * Enter and arrow / Ctrl+N/P navigation are handled by the global
//     keydown branch above the dispatcher (they're identical in both modes
//     and shouldn't reset the chord buffer), so they don't appear here.
//   * <Space> is the leader prefix — single Space alone is unbound; the
//     bound chords are " m" (manage). More leader chords will land in v3
//     (theme toggle, reload, etc.).
const KEYMAP_NORMAL = {
  "j":   "nav-down",
  "k":   "nav-up",
  "gg":  "nav-top",
  "G":   "nav-bottom",
  "i":   "enter-insert",
  "a":   "add",
  "e":   "edit",
  "dd":  "delete",
  "u":   "undo",
  "/":   "enter-insert",
  "?":   "show-help",
  " m":  "goto-manage",   // <Space>m — jump to /manage
  " t":  "cycle-theme",   // <Space>t — cycle through built-in themes
};

function dispatchNormalKey(key, event) {
  // Defensive: some keyboard sources (notably Playwright on `Shift+g`) send
  // a lowercase `e.key` with `e.shiftKey=true` instead of the shifted
  // character. If shift is held and we got a lowercase ASCII letter, also
  // try its uppercase. Same for the standard US Shift+/ → "?" mapping.
  // Real-browser users already get the shifted character in `e.key` so this
  // never triggers for them; it just makes the dispatch behave the same
  // across input event sources.
  if (event.shiftKey) {
    if (key === "/") key = "?";
    else if (key.length === 1 && key >= "a" && key <= "z") key = key.toUpperCase();
  }

  if (chordTimer) { clearTimeout(chordTimer); chordTimer = null; }
  const next = chordBuffer + key;

  // Exact match → execute.
  if (KEYMAP_NORMAL[next]) {
    event.preventDefault();
    chordBuffer = "";
    ACTIONS[KEYMAP_NORMAL[next]](event);
    return;
  }

  // Prefix match → wait for the next key.
  const isPrefix = Object.keys(KEYMAP_NORMAL).some(
    (k) => k.length > next.length && k.startsWith(next)
  );
  if (isPrefix) {
    event.preventDefault();
    chordBuffer = next;
    chordTimer = setTimeout(() => { chordBuffer = ""; }, CHORD_TIMEOUT_MS);
    return;
  }

  // No match, no prefix. Drop the accumulated buffer and re-try this key
  // alone — handy when "g" times out then the user presses "j".
  chordBuffer = "";
  if (KEYMAP_NORMAL[key]) {
    event.preventDefault();
    ACTIONS[KEYMAP_NORMAL[key]](event);
  }
  // Otherwise the key falls through (unbound in normal mode).
}

// Global key handler — runs at capture phase so we can override input behavior.
document.addEventListener("keydown", (e) => {
  // Modal handles its own keys; bail when one is open.
  if (document.querySelector(".modal-overlay")) return;

  // Universally-safe modifier shortcuts — both modes.
  // ⌘⏎ / Ctrl+⏎ → open selected in new tab.
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    openSelected(true);
    return;
  }
  // ⏎ (no modifier) → open selected.
  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    openSelected(false);
    return;
  }

  // Arrow keys + Ctrl+N / Ctrl+P navigate in both modes. (Note: e.key on
  // Ctrl+N/P is "n"/"p" — lower-case — without Shift; we don't need
  // to check case here.)
  if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
    e.preventDefault(); move(1); return;
  }
  if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
    e.preventDefault(); move(-1); return;
  }

  // Vim half-page scroll: Ctrl+D down, Ctrl+U up. Active in both modes
  // (snacks.nvim-style — the input never sees a literal Ctrl, so there's
  // no conflict with typing). Inside an input, this overrides the
  // emacs-style "delete forward / kill to line start" defaults; acceptable
  // tradeoff for a keyboard-driven picker.
  if (e.ctrlKey && (e.key === "d" || e.key === "u")) {
    e.preventDefault();
    pageScroll(e.key === "d" ? 1 : -1);
    return;
  }

  // Any other ⌘/Ctrl-modified key falls through so browser shortcuts like
  // ⌘+R reload, ⌘+L address-bar, ⌘+W close still work.
  if (e.metaKey || e.ctrlKey) return;

  // Esc: insert → normal (blur the input; mode flips via the blur listener).
  // Normal: no-op (vim-faithful).
  if (e.key === "Escape") {
    if (state.mode === "insert") $q.blur();
    return;
  }

  // Normal-mode dispatch. Single-char printable keys, plus Enter (already
  // handled above) go through the chord layer.
  if (state.mode === "normal") {
    // Ignore modifier keydowns themselves (Meta/Shift/etc.) — they aren't
    // meaningful chord characters and shouldn't reset the buffer.
    if (e.key === "Shift" || e.key === "Meta" || e.key === "Control" || e.key === "Alt") return;
    // Only feed single-character keys to the dispatcher. Multi-char keys
    // (ArrowLeft, F1, Tab, …) are handled by other branches or unbound.
    if (e.key.length === 1) {
      dispatchNormalKey(e.key, e);
    }
    return;
  }

  // Insert mode: `/` from outside the input focuses it. (When inside the
  // input it just types into the query as a character.)
  if (e.key === "/" && document.activeElement !== $q) {
    e.preventDefault();
    $q.focus();
    return;
  }
  // Everything else in insert mode falls through to the input element.
});

// Click-to-select on rows
$list.addEventListener("click", (e) => {
  const li = e.target.closest(".row");
  if (!li) return;
  const idx = [...$list.children].indexOf(li);
  if (idx >= 0) { state.selected = idx; render(); }
});

load();

const $modalRoot = document.getElementById("modal-root");

function openModal({ title, initial = {}, onSave }) {
  closeModal(); // ensure single modal
  $modalRoot.innerHTML = `
    <div class="modal-overlay" role="dialog" aria-modal="true">
      <div class="modal">
        <h2><span>${escapeHTML(title)}</span><span class="esc">⎋ to cancel</span></h2>
        <div class="field">
          <label>URL <span style="color:var(--red)">*</span></label>
          <input id="m-url" type="text" value="${escapeHTML(initial.url || "")}" placeholder="https://…">
          <div class="hint">required — validated as a URL on submit</div>
        </div>
        <div class="field">
          <label>Title <span style="color:var(--red)">*</span></label>
          <input id="m-title" type="text" value="${escapeHTML(initial.title || "")}" placeholder="Team Dashboard">
          <div class="hint">defaults to URL hostname if blank</div>
        </div>
        <div class="field">
          <label>Tags</label>
          <input id="m-tags" type="text" value="${escapeHTML((initial.tags || []).join(", "))}" placeholder="work, jira">
          <div class="hint">comma-separated, optional</div>
        </div>
        <div class="field">
          <label>Aliases</label>
          <input id="m-aliases" type="text" value="${escapeHTML((initial.aliases || []).join(", "))}" placeholder="team board, sprint board">
          <div class="hint">extra fuzzy-search keywords, not shown in the list</div>
        </div>
        <div id="m-error" class="error" style="display:none"></div>
        <div class="modal-footer">
          <span>Tab to cycle · ⏎ save · ⎋ cancel</span>
          <div class="actions">
            <button id="m-cancel" class="btn">Cancel</button>
            <button id="m-save" class="btn btn-primary">Save</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const $url = document.getElementById("m-url");
  const $title = document.getElementById("m-title");
  const $tags = document.getElementById("m-tags");
  const $aliases = document.getElementById("m-aliases");
  const $err = document.getElementById("m-error");

  $url.focus();
  $url.select();

  const submit = async () => {
    const url = $url.value.trim();
    if (!url) { showErr("URL is required"); return; }
    let parsed;
    try { parsed = new URL(url); } catch { showErr("URL is not valid"); return; }
    const titleVal = $title.value.trim() || parsed.hostname;
    const tags = $tags.value.split(",").map(s => s.trim()).filter(Boolean);
    const aliases = $aliases.value.split(",").map(s => s.trim()).filter(Boolean);
    try {
      await onSave({ url, title: titleVal, tags, aliases });
      closeModal();
    } catch (err) {
      showErr(err.message || "save failed");
    }
  };

  document.getElementById("m-save").addEventListener("click", submit);
  document.getElementById("m-cancel").addEventListener("click", closeModal);

  $modalRoot.querySelector(".modal").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeModal(); return; }
    if (e.key === "Enter") { e.preventDefault(); submit(); return; }
  });

  function showErr(msg) {
    $err.textContent = msg;
    $err.style.display = "block";
  }
}

function closeModal() {
  $modalRoot.innerHTML = "";
  $q.focus();
}

// Keymap help overlay. Reuses #modal-root and the existing Esc-to-close
// pattern. Read-only — no inputs, no save button.
function showHelpOverlay() {
  closeModal();
  $modalRoot.innerHTML = `
    <div class="modal-overlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div class="modal">
        <h2><span>Keyboard shortcuts</span><span class="esc">⎋ to close</span></h2>
        <div class="help-section">
          <div class="help-section-title">Insert mode</div>
          <dl class="help-list">
            <dt>⎋</dt><dd>enter normal mode</dd>
            <dt>⏎</dt><dd>open selected</dd>
            <dt>⌘⏎ / Ctrl+⏎</dt><dd>open in new tab</dd>
            <dt>↑ ↓ / Ctrl+N / Ctrl+P</dt><dd>move selection</dd>
            <dt>Ctrl+D / Ctrl+U</dt><dd>half-page down / up</dd>
          </dl>
        </div>
        <div class="help-section">
          <div class="help-section-title">Normal mode</div>
          <dl class="help-list">
            <dt>j  k</dt><dd>down / up</dd>
            <dt>Ctrl+D / Ctrl+U</dt><dd>half-page down / up</dd>
            <dt>gg</dt><dd>top of list</dd>
            <dt>G</dt><dd>bottom of list</dd>
            <dt>⏎</dt><dd>open selected</dd>
            <dt>⌘⏎ / Ctrl+⏎</dt><dd>open in new tab</dd>
            <dt>i  a  /</dt><dd>enter insert mode</dd>
            <dt>a</dt><dd>add bookmark</dd>
            <dt>e</dt><dd>edit selected</dd>
            <dt>dd</dt><dd>delete selected</dd>
            <dt>u</dt><dd>undo last add/edit/delete</dd>
            <dt>?</dt><dd>this help</dd>
            <dt>&lt;Space&gt;m</dt><dd>jump to /manage</dd>
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
  // Focus the close button so Esc-listener picks up keystrokes without a
  // text input stealing them.
  document.getElementById("m-close").focus();
}

async function createBookmark(payload) {
  const r = await fetch("/api/bookmarks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  const created = await r.json();
  // Push undo entry only on success (after we know the server accepted).
  state.undoStack.push({ kind: "add", id: created.id });
  await load();
  // Auto-select the newly created bookmark
  const idx = state.view.findIndex(b => b.id === created.id);
  if (idx >= 0) { state.selected = idx; render(); }
}

async function updateBookmark(id, payload) {
  // Snapshot the full pre-edit bookmark BEFORE the PUT. Undo just re-PUTs the
  // entire snapshot — cell-level granularity isn't needed.
  const before = state.bookmarks.find((b) => b.id === id);
  const prev = before
    ? {
        title: before.title,
        url: before.url,
        tags: [...(before.tags || [])],
        aliases: [...(before.aliases || [])],
      }
    : null;
  const r = await fetch("/api/bookmarks/" + encodeURIComponent(id), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  if (prev) state.undoStack.push({ kind: "edit", id, prev });
  await load();
}

async function deleteBookmark(id) {
  // Snapshot the full bookmark BEFORE the DELETE so undo can re-POST it.
  // Restored deletes get a NEW server-assigned id (Store.Add always issues
  // a fresh Crockford); the old id is gone forever.
  const before = state.bookmarks.find((b) => b.id === id);
  const prev = before
    ? {
        title: before.title,
        url: before.url,
        tags: [...(before.tags || [])],
        aliases: [...(before.aliases || [])],
      }
    : null;
  const r = await fetch("/api/bookmarks/" + encodeURIComponent(id), { method: "DELETE" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (prev) state.undoStack.push({ kind: "delete", prev });
  await load();
}

// Undo the most recent successful add / edit / delete from this view's stack.
// Silent: the reappearing / disappearing / reverting row IS the feedback.
// On failure (e.g. user over-undid into a stale reference), alert and stop —
// don't auto-skip or auto-recover.
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
