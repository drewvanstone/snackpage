// snackpage frontend. Vanilla JS, no build step.
// Public surface: nothing — everything is module-scoped.

import { openThemePicker } from "./theme.js";
import { scoreBookmarkMatches } from "./search.js";
import {
  DEFAULT_WEB_SEARCH_PROVIDER_ID,
  getWebSearchProvider,
} from "./web-search.js";

const state = {
  bookmarks: [],   // [{id,title,url,tags,aliases,visit_count,last_visit_at,frecency_score}]
  view: [],        // filtered + sorted subset rendered to DOM
  selectedId: null,
  selectedSearchProviderId: null,
  mode: "insert",  // "insert" | "normal" — vim-style modal editor mode
  mutationBlocked: false,
  mutationInFlight: false,
  // In-memory undo stack. One entry per successful add / edit / delete.
  // Per-view: refreshing the page or switching to /manage clears it.
  // Entry shapes:
  //   { kind: "add",    id }                              — undo POSTed bookmark
  //   { kind: "edit",   id, prev: {title,url,tags,aliases} } — restore pre-edit
  //   { kind: "delete", id, prev: {title,url,tags,aliases} } — re-POST (NEW id)
  undoStack: [],
};

const $q = document.getElementById("q");
const $list = document.getElementById("list");
const $count = document.getElementById("count");
const $picker = document.getElementById("picker");
const $hints = document.getElementById("hints");
const $status = document.getElementById("status");
let lastLoadedAt = 0;
let loadGeneration = 0;

function currentWebSearch() {
  const query = $q.value.trim();
  if (query === "") return null;
  const provider = getWebSearchProvider(DEFAULT_WEB_SEARCH_PROVIDER_ID);
  return provider ? { provider, query } : null;
}

function resultCount() {
  return state.view.length + (currentWebSearch() ? 1 : 0);
}

function selectBookmarkId(id) {
  state.selectedId = id;
  state.selectedSearchProviderId = null;
}

function selectWebSearch(providerId) {
  state.selectedId = null;
  state.selectedSearchProviderId = providerId;
}

function clearSelection() {
  state.selectedId = null;
  state.selectedSearchProviderId = null;
}

// Footer hints text per mode. The visible affordance should match what the
// keyboard actually does: in insert you press ⎋ to leave to normal; in
// normal you press i or / to return to insert and a/e/dd run app commands.
const HINTS = {
  insert: "↑↓ select · ⏎ open · ⎋ normal mode",
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

async function load({ preserveSelection = true } = {}) {
  const generation = ++loadGeneration;
  const previousId = preserveSelection ? state.selectedId : null;
  const previousSearchProviderId = preserveSelection
    ? state.selectedSearchProviderId
    : null;
  try {
    const json = await apiFetch("/api/bookmarks");
    if (generation !== loadGeneration) return;
    if (!Array.isArray(json?.bookmarks)) {
      throw new Error("server returned an invalid bookmark list");
    }
    state.bookmarks = json.bookmarks;
    state.selectedId = previousId;
    state.selectedSearchProviderId = previousSearchProviderId;
    refresh({ resetSelection: !preserveSelection });
    lastLoadedAt = Date.now();
    if (state.mutationBlocked) {
      setStatus(
        "A previous save has an unknown outcome; reload before making more changes.",
        true,
      );
    } else {
      setStatus();
    }
  } catch (error) {
    if (generation !== loadGeneration) return;
    setStatus(`Could not load bookmarks: ${error.message}`, true);
  }
}

function refresh({ resetSelection = false } = {}) {
  const q = $q.value.trim();
  if (q === "") {
    state.view = [];
  } else {
    state.view = fuzzyRank(q, state.bookmarks);
  }
  const webSearch = currentWebSearch();
  const selectedBookmarkVisible = Boolean(
    state.selectedId &&
    state.view.some((bookmark) => bookmark.id === state.selectedId)
  );
  const selectedSearchAvailable = Boolean(
    webSearch &&
    state.selectedSearchProviderId === webSearch.provider.id
  );
  if (
    resetSelection ||
    (!selectedBookmarkVisible && !selectedSearchAvailable)
  ) {
    if (state.view.length > 0) {
      selectBookmarkId(state.view[0].id);
    } else if (webSearch) {
      selectWebSearch(webSearch.provider.id);
    } else {
      clearSelection();
    }
  }
  render();
}

// Rank the matches admitted by the shared relevance filter. Frecency remains
// a small tie-breaker after weighted title/alias/tag/URL match quality.
function fuzzyRank(q, items) {
  const ranked = scoreBookmarkMatches(q, items, window.fzf).map(
    ({ score, item }) => ({
      item,
      score: score + 0.001 * (Number(item.frecency_score) || 0),
    }),
  );
  ranked.sort((a, z) =>
    z.score - a.score ||
    a.item.title.localeCompare(z.item.title) ||
    a.item.url.localeCompare(z.item.url) ||
    a.item.id.localeCompare(z.item.id)
  );
  return ranked.map(r => r.item);
}

function relTime(iso) {
  if (!iso) return "";
  const parsed = new Date(iso).getTime();
  if (!Number.isFinite(parsed)) return "";
  const ms = Math.max(0, Date.now() - parsed);
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

// Compact URL display for the row sub-line. Titles are the primary identifier
// so the host alone is enough at a glance; the full URL stays on hover via
// the title= attribute. Falls back to the raw URL on parse error so weird
// schemes (data:, chrome:, file:) still render something.
function displayHost(url) {
  try {
    const u = new URL(url);
    if (!u.hostname) return url;
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function render() {
  $list.innerHTML = "";
  state.view.forEach((b) => {
    const li = document.createElement("li");
    li.className = "row";
    const selected =
      state.selectedSearchProviderId === null &&
      b.id === state.selectedId;
    li.id = `bookmark-option-${b.id}`;
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", selected ? "true" : "false");
    li.dataset.id = b.id;
    li.dataset.resultKind = "bookmark";
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
        <div class="sub" title="${escapeHTML(b.url)}">${escapeHTML(displayHost(b.url))}${tagsHTML}</div>
      </div>
      <div class="meta">${relTime(b.last_visit_at)}<span class="count">${b.visit_count || 0} visits</span></div>
    `;
    $list.appendChild(li);
  });

  const webSearch = currentWebSearch();
  if (webSearch) {
    const { provider, query } = webSearch;
    const label = `Search ${provider.name} for “${query}”`;
    const li = document.createElement("li");
    li.className = "row web-search-row";
    li.id = `web-search-option-${provider.id}`;
    li.setAttribute("role", "option");
    li.setAttribute("aria-label", label);
    li.setAttribute(
      "aria-selected",
      state.selectedSearchProviderId === provider.id ? "true" : "false",
    );
    li.dataset.resultKind = "web-search";
    li.dataset.searchProvider = provider.id;
    li.innerHTML = `
      <span class="marker">▌</span>
      <div>
        <div class="title">${escapeHTML(label)}</div>
        <div class="sub">${escapeHTML(provider.displayHost)}  ·  web search</div>
      </div>
      <div class="meta">web</div>
    `;
    $list.appendChild(li);
  }

  $count.textContent = `${state.view.length} / ${state.bookmarks.length}`;
  $q.setAttribute("aria-expanded", String(resultCount() > 0));
  if (state.selectedId) {
    $q.setAttribute(
      "aria-activedescendant",
      `bookmark-option-${state.selectedId}`,
    );
  } else if (webSearch && state.selectedSearchProviderId === webSearch.provider.id) {
    $q.setAttribute(
      "aria-activedescendant",
      `web-search-option-${webSearch.provider.id}`,
    );
  } else {
    $q.removeAttribute("aria-activedescendant");
  }
}

$q.addEventListener("input", () => {
  refresh({ resetSelection: true });
  // A new query selects the best match, so it must also reveal the top of the
  // new result set instead of preserving an unrelated prior scroll position.
  $list.scrollTop = 0;
});

function selectedIndex() {
  const bookmarkIndex = state.view.findIndex(
    (bookmark) => bookmark.id === state.selectedId,
  );
  if (bookmarkIndex >= 0) return bookmarkIndex;
  const webSearch = currentWebSearch();
  if (
    webSearch &&
    state.selectedSearchProviderId === webSearch.provider.id
  ) {
    return state.view.length;
  }
  return -1;
}

function selectedBookmark() {
  return state.view.find((bookmark) => bookmark.id === state.selectedId);
}

function selectedWebSearch() {
  const webSearch = currentWebSearch();
  if (
    webSearch &&
    state.selectedSearchProviderId === webSearch.provider.id
  ) {
    return webSearch;
  }
  return null;
}

function selectRenderedRow(li) {
  const id = li.dataset.id;
  const searchProviderId = li.dataset.searchProvider;
  if (id) {
    selectBookmarkId(id);
  } else if (
    li.dataset.resultKind === "web-search" &&
    searchProviderId
  ) {
    selectWebSearch(searchProviderId);
  } else {
    return false;
  }
  for (const row of $list.querySelectorAll(".row")) {
    row.setAttribute("aria-selected", row === li ? "true" : "false");
  }
  $q.setAttribute("aria-activedescendant", li.id);
  return true;
}

function mutationsAllowed() {
  if (!state.mutationBlocked) return true;
  setStatus(
    "A previous save has an unknown outcome; reload before making more changes.",
    true,
  );
  return false;
}

async function runMutation(task) {
  if (!mutationsAllowed() || state.mutationInFlight) return false;
  state.mutationInFlight = true;
  try {
    await task();
    return true;
  } finally {
    state.mutationInFlight = false;
  }
}

function selectIndex(index) {
  const count = resultCount();
  if (count === 0) {
    clearSelection();
    return;
  }
  const clamped = Math.max(0, Math.min(count - 1, index));
  if (clamped < state.view.length) {
    selectBookmarkId(state.view[clamped].id);
    return;
  }
  const webSearch = currentWebSearch();
  if (webSearch) selectWebSearch(webSearch.provider.id);
}

function scrollSelectedIntoView() {
  const sel = $list.querySelector('[aria-selected="true"]');
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

function move(delta) {
  const count = resultCount();
  if (count === 0) return;
  const current = Math.max(0, selectedIndex());
  selectIndex((current + delta + count) % count);
  render();
  scrollSelectedIntoView();
}

// Half-page scroll, vim's Ctrl+D / Ctrl+U. Move selection by half the
// currently visible row count, clamped at the list edges (no wrap).
function pageScroll(direction) {
  const count = resultCount();
  if (count === 0) return;
  const firstRow = $list.querySelector("li");
  if (!firstRow) return;
  const rowH = firstRow.offsetHeight || 1;
  const halfVisible = Math.max(1, Math.floor($list.clientHeight / rowH / 2));
  const current = Math.max(0, selectedIndex());
  selectIndex(Math.max(
    0,
    Math.min(count - 1, current + direction * halfVisible),
  ));
  render();
  scrollSelectedIntoView();
}

function openSelected(newTab) {
  const b = selectedBookmark();
  const webSearch = selectedWebSearch();
  if (!b && !webSearch) return;
  const url = b
    ? "/go/" + encodeURIComponent(b.id)
    : webSearch.provider.buildURL(webSearch.query);
  if (newTab) window.open(url, "_blank", "noopener");
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
    if (resultCount()) { selectIndex(0); render(); scrollSelectedIntoView(); }
  },
  "nav-bottom":    () => {
    if (resultCount()) { selectIndex(resultCount() - 1); render(); scrollSelectedIntoView(); }
  },
  "open":          () => openSelected(false),
  "open-new-tab":  () => openSelected(true),
  "enter-insert":  () => {
    $q.focus();
    const len = $q.value.length;
    $q.setSelectionRange(len, len);
  },
  "add":           () => {
    if (mutationsAllowed() && !state.mutationInFlight) {
      openModal({ title: "Add bookmark", onSave: createBookmark });
    }
  },
  "edit":          () => {
    if (!mutationsAllowed() || state.mutationInFlight) return;
    const b = selectedBookmark();
    if (!b) return;
    openModal({
      title: "Edit bookmark",
      initial: b,
      onSave: (payload) => updateBookmark(b.id, payload),
    });
  },
  "delete":        () => {
    if (!mutationsAllowed()) return;
    const b = selectedBookmark();
    if (!b) return;
    runMutation(async () => {
      try {
        await deleteBookmark(b.id);
      } catch (err) {
        if (err.unknownOutcome) state.mutationBlocked = true;
        setStatus(`Delete failed: ${err.message}`, true);
      }
    });
  },
  "undo":          () => {
    runMutation(undo);
  },
  "show-help":     () => showHelpOverlay(),
  "goto-manage":   () => { if (window.location.pathname !== "/manage") window.location.href = "/manage"; },
  "open-theme-picker": () => openThemePicker(),
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
  " t":  "open-theme-picker",   // <Space>t — open theme picker overlay
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

// Global key handler. Input behavior that belongs to the picker is handled
// here; native controls outside the query retain their browser defaults.
document.addEventListener("keydown", (e) => {
  // Modal handles its own keys; bail when one is open.
  if (document.querySelector(".modal-overlay")) return;

  const target = e.target;
  const nativeInteractive =
    target instanceof Element &&
    target !== $q &&
    Boolean(target.closest("a, button, select, textarea, [contenteditable='true']"));

  // Universally-safe modifier shortcuts — both modes.
  // ⌘⏎ / Ctrl+⏎ → open selected in new tab.
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    if (nativeInteractive) return;
    e.preventDefault();
    openSelected(true);
    return;
  }
  // ⏎ (no modifier) → open selected.
  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
    if (nativeInteractive) return;
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

// Pointer selection mirrors keyboard selection. Update the existing DOM
// instead of re-rendering it so moving onto a row cannot replace the click
// target between hover and click (notably in Safari).
$list.addEventListener("pointerover", (e) => {
  const li = e.target instanceof Element ? e.target.closest(".row") : null;
  if (li) selectRenderedRow(li);
});

// A primary click opens the row under the pointer. Cmd/Ctrl-click preserves
// the keyboard shortcut's open-in-new-tab behavior.
$list.addEventListener("click", (e) => {
  const li = e.target instanceof Element ? e.target.closest(".row") : null;
  if (!li) return;
  if (!selectRenderedRow(li)) return;
  e.preventDefault();
  openSelected(e.metaKey || e.ctrlKey);
});

load({ preserveSelection: false });
reconcilePickerMode({ requestDefaultFocus: true });

// Returning from /go/ via the back-forward cache or switching back to this
// tab should refresh visit counts and server-provided frecency.
window.addEventListener("pageshow", (event) => {
  reconcilePickerMode();
  if (event.persisted) load();
});
window.addEventListener("focus", () => {
  if (Date.now() - lastLoadedAt > 1000) load();
});

const $modalRoot = document.getElementById("modal-root");
let modalReturnFocus = null;
let modalCleanup = null;

function normalizeURL(value) {
  const trimmed = value.trim();
  return trimmed && !trimmed.includes("://") ? `https://${trimmed}` : trimmed;
}

function beginModal(markup) {
  const returnFocus = $modalRoot.firstElementChild
    ? modalReturnFocus
    : document.activeElement;
  closeModal({ restoreFocus: false });
  modalReturnFocus = returnFocus;
  $modalRoot.innerHTML = markup;

  const dialog = $modalRoot.querySelector('[role="dialog"]');
  const trapFocus = (event) => {
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    )].filter((element) => !element.hidden);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  dialog.addEventListener("keydown", trapFocus);
  modalCleanup = () => dialog.removeEventListener("keydown", trapFocus);
  return dialog;
}

function openModal({ title, initial = {}, onSave }) {
  const titleId = "bookmark-modal-title";
  const dialog = beginModal(`
    <div class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <div class="modal" tabindex="-1">
        <h2 id="${titleId}"><span>${escapeHTML(title)}</span><span class="esc">⎋ to cancel</span></h2>
        <div class="field">
          <label for="m-url">URL <span class="required" aria-hidden="true">*</span></label>
          <input id="m-url" type="text" required aria-required="true" value="${escapeHTML(initial.url || "")}" placeholder="https://…">
          <div class="hint">required — validated as a URL on submit</div>
        </div>
        <div class="field">
          <label for="m-title">Title</label>
          <input id="m-title" type="text" value="${escapeHTML(initial.title || "")}" placeholder="Team Dashboard">
          <div class="hint">defaults to URL hostname if blank</div>
        </div>
        <div class="field">
          <label for="m-tags">Tags</label>
          <input id="m-tags" type="text" value="${escapeHTML((initial.tags || []).join(", "))}" placeholder="work, jira">
          <div class="hint">comma-separated, optional</div>
        </div>
        <div class="field">
          <label for="m-aliases">Aliases</label>
          <input id="m-aliases" type="text" value="${escapeHTML((initial.aliases || []).join(", "))}" placeholder="team board, sprint board">
          <div class="hint">extra fuzzy-search keywords, not shown in the list</div>
        </div>
        <div id="m-error" class="error" role="alert" hidden></div>
        <div class="modal-footer">
          <span>Tab to cycle · ⏎ save · ⎋ cancel</span>
          <div class="actions">
            <button id="m-cancel" type="button" class="btn">Cancel</button>
            <button id="m-save" type="button" class="btn btn-primary">Save</button>
          </div>
        </div>
      </div>
    </div>
  `);

  const $url = document.getElementById("m-url");
  const $title = document.getElementById("m-title");
  const $tags = document.getElementById("m-tags");
  const $aliases = document.getElementById("m-aliases");
  const $err = document.getElementById("m-error");
  const $cancel = document.getElementById("m-cancel");
  const $save = document.getElementById("m-save");
  let submitting = false;
  let requestPending = false;

  $url.focus();
  $url.select();

  const submit = async () => {
    if (submitting || state.mutationInFlight || !mutationsAllowed()) return;
    const url = normalizeURL($url.value);
    if (!url) { showErr("URL is required"); return; }
    let parsed;
    try {
      parsed = new URL(url);
      if (!parsed.protocol || !parsed.host) throw new Error();
    } catch {
      showErr("URL is not valid");
      return;
    }
    const titleVal = $title.value.trim() || parsed.hostname;
    const tags = $tags.value.split(",").map(s => s.trim()).filter(Boolean);
    const aliases = $aliases.value.split(",").map(s => s.trim()).filter(Boolean);
    submitting = true;
    requestPending = true;
    $cancel.disabled = true;
    $save.disabled = true;
    $err.hidden = true;
    try {
      await runMutation(() =>
        onSave({ url, title: titleVal, tags, aliases })
      );
      requestPending = false;
      if (dialog.isConnected) closeModal();
    } catch (err) {
      requestPending = false;
      showErr(err.message || "save failed");
      if (err.unknownOutcome) {
        state.mutationBlocked = true;
        setStatus(err.message, true);
        $cancel.disabled = false;
        $url.focus();
      } else {
        submitting = false;
        $cancel.disabled = false;
        $save.disabled = false;
      }
    }
  };

  $save.addEventListener("click", submit);
  $cancel.addEventListener("click", () => {
    if (!requestPending) closeModal();
  });

  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (!requestPending) closeModal();
      return;
    }
    if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      submit();
    }
  });

  function showErr(msg) {
    $err.textContent = msg;
    $err.hidden = false;
  }
}

function closeModal({ restoreFocus = true } = {}) {
  if (modalCleanup) modalCleanup();
  modalCleanup = null;
  $modalRoot.innerHTML = "";
  const returnFocus = modalReturnFocus;
  modalReturnFocus = null;
  if (!restoreFocus) return;
  if (returnFocus instanceof HTMLElement && returnFocus.isConnected) {
    returnFocus.focus();
  } else {
    $q.focus();
  }
}

function reconcilePickerMode({ requestDefaultFocus = false } = {}) {
  const active = document.activeElement;
  if (
    requestDefaultFocus &&
    (active === document.body || active === document.documentElement)
  ) {
    // Autofocus can be suppressed (for example in an embedded page). Make
    // one best-effort request, then derive mode from the focus that actually
    // exists instead of leaving the app in a stale insert state.
    $q.focus({ preventScroll: true });
  }
  setMode(document.activeElement === $q ? "insert" : "normal");
}

// Keymap help overlay. Reuses #modal-root and the existing Esc-to-close
// pattern. Read-only — no inputs, no save button.
function showHelpOverlay() {
  const dialog = beginModal(`
    <div class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="help-title">
      <div class="modal" tabindex="-1">
        <h2 id="help-title"><span>Keyboard shortcuts</span><span class="esc">⎋ to close</span></h2>
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
            <dt>i  /</dt><dd>enter insert mode</dd>
            <dt>a</dt><dd>add bookmark</dd>
            <dt>e</dt><dd>edit selected</dd>
            <dt>dd</dt><dd>delete selected</dd>
            <dt>u</dt><dd>undo last add/edit/delete</dd>
            <dt>?</dt><dd>this help</dd>
            <dt>&lt;Space&gt;m</dt><dd>jump to /manage</dd>
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
  `);

  document.getElementById("m-close").addEventListener("click", closeModal);
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeModal(); return; }
  });
  // Focus the close button so Esc-listener picks up keystrokes without a
  // text input stealing them.
  document.getElementById("m-close").focus();
}

async function createBookmark(payload) {
  const created = requireBookmark(await apiFetch("/api/bookmarks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }));
  state.undoStack.push({ kind: "add", id: created.id });
  selectBookmarkId(created.id);
  await load();
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
  requireBookmark(await apiFetch("/api/bookmarks/" + encodeURIComponent(id), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }));
  if (prev) state.undoStack.push({ kind: "edit", id, prev });
  selectBookmarkId(id);
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
  await apiFetch("/api/bookmarks/" + encodeURIComponent(id), { method: "DELETE" });
  if (prev) state.undoStack.push({ kind: "delete", id, prev });
  await load();
}

function rekeyUndoReferences(oldId, newId) {
  for (const item of state.undoStack) {
    if (item.id === oldId) item.id = newId;
  }
  if (state.selectedId === oldId) selectBookmarkId(newId);
}

async function undo() {
  if (!mutationsAllowed()) return;
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
      selectBookmarkId(restored.id);
    } else if (entry.kind === "edit") {
      requireBookmark(await apiFetch("/api/bookmarks/" + encodeURIComponent(entry.id), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry.prev),
      }));
      selectBookmarkId(entry.id);
    } else if (entry.kind === "add") {
      await apiFetch("/api/bookmarks/" + encodeURIComponent(entry.id), {
        method: "DELETE",
      });
    }
    await load();
  } catch (err) {
    if (err.unknownOutcome) state.mutationBlocked = true;
    else state.undoStack.push(entry);
    setStatus(`Undo failed: ${err.message}`, true);
  }
}
