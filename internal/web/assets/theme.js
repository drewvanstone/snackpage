// snackpage frontend — theme switcher.
//
// Sister module to the synchronous <head> bootstrap in index.html/manage.html.
// The bootstrap resolves the active theme before paint (URL param >
// localStorage > default) and appends the theme <link>; this module gives
// app.js and manage.js a runtime hook to swap themes from <Space>t (now via
// openThemePicker — a modal overlay with live preview).

// theme-registry.js is deliberately classic/synchronous so it can also be
// consumed by the pre-paint bootstrap without permitting inline scripts.
export const THEMES = globalThis.SnackpageThemes || Object.freeze([]);

function isKnownTheme(name) {
  return THEMES.some((theme) => theme.id === name);
}

function themeHref(name) {
  const current = document.getElementById("theme-css")?.getAttribute("href") || "";
  const query = current.includes("?") ? current.slice(current.indexOf("?")) : "";
  return `/static/themes/${name}.css${query}`;
}

export function currentTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  return isKnownTheme(current) ? current : THEMES[0]?.id;
}

// Apply theme to the DOM and persist the choice to localStorage. The picker
// overlay commits via this; the cancel path uses previewTheme() instead so
// the user's storage isn't touched.
export function setTheme(name) {
  if (!isKnownTheme(name)) return false;
  document.documentElement.setAttribute("data-theme", name);
  const link = document.getElementById("theme-css");
  if (link) {
    link.href = themeHref(name);
  } else {
    // Defensive: the bootstrap appended #theme-css before this module ran,
    // but if it isn't there (custom HTML, test harness, etc.) we recreate it.
    const fresh = document.createElement("link");
    fresh.rel = "stylesheet";
    fresh.id = "theme-css";
    fresh.href = themeHref(name);
    document.head.appendChild(fresh);
  }
  try {
    localStorage.setItem("snackpageTheme", name);
  } catch {
    // Storage can throw in privacy-restricted or embedded contexts. The
    // in-page theme change is still valid and should not be rolled back.
  }
  return true;
}

// Same DOM updates as setTheme but does NOT save to localStorage. Used by
// the picker overlay to apply each theme as the user navigates without
// committing. Esc → revert via previewTheme(originalTheme) leaves storage
// untouched.
export function previewTheme(name) {
  if (!isKnownTheme(name)) return false;
  document.documentElement.setAttribute("data-theme", name);
  const link = document.getElementById("theme-css");
  if (link) link.href = themeHref(name);
  return true;
}

// Legacy cycle helper — no longer wired to <Space>t (the picker overlay
// took its place) but kept as a callable API for future tooling/extensions
// (URL params, e2e harnesses, etc.).
export function cycleTheme() {
  if (THEMES.length === 0) return "";
  const cur = currentTheme();
  const idx = THEMES.findIndex((t) => t.id === cur);
  const next = THEMES[(idx + 1) % THEMES.length];
  setTheme(next.id);
  return next.id;
}

// Open a modal theme picker — a fzf-filtered list with the same insert/normal
// modal-editor pattern as the main bookmark picker. Insert mode: type to
// filter, ↑↓ nav. Normal mode (Esc from insert): j/k nav. Enter applies and
// persists; second Esc from normal closes and reverts to the pre-overlay
// theme. Same picker works in both the picker and manage views (each has
// #modal-root).
//
// Implementation note: the shell renders once; updateList()/updateHint() patch
// in place so the <input> isn't destroyed on every keystroke (preserves caret
// + focus). The overlay carries class .modal-overlay so app.js / manage.js's
// chord dispatcher bails on its presence.
export function openThemePicker() {
  const modalRoot = document.getElementById("modal-root");
  if (!modalRoot) return;

  if (THEMES.length === 0) return;
  const returnFocus = document.activeElement;
  const originalTheme = currentTheme();
  let mode = "insert"; // "insert" | "normal"
  let query = "";
  let filtered = THEMES.slice();
  let selectedIdx = THEMES.findIndex((t) => t.id === originalTheme);
  if (selectedIdx < 0) selectedIdx = 0;

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
    );
  }

  function applyFilter() {
    const q = query.trim();
    if (!q) {
      filtered = THEMES.slice();
      return;
    }
    const F = window.fzf;
    if (F && F.Fzf) {
      const finder = new F.Fzf(THEMES, {
        selector: (t) => `${t.name} ${t.description} ${t.id}`,
      });
      filtered = finder.find(q).map((r) => r.item);
      return;
    }
    // Substring fallback when fzf failed to load.
    const lq = q.toLowerCase();
    filtered = THEMES.filter((t) =>
      `${t.name} ${t.description} ${t.id}`.toLowerCase().includes(lq),
    );
  }

  function clampSelected() {
    if (filtered.length === 0) { selectedIdx = 0; return; }
    if (selectedIdx >= filtered.length) selectedIdx = filtered.length - 1;
    if (selectedIdx < 0) selectedIdx = 0;
  }

  function previewSelected() {
    if (filtered.length > 0) previewTheme(filtered[selectedIdx].id);
    // No matches: leave the current preview untouched (no jumpy snap-back).
  }

  function buildShell() {
    modalRoot.innerHTML = `
      <div class="modal-overlay theme-picker-overlay" role="dialog" aria-modal="true" aria-labelledby="theme-picker-title" data-mode="${mode}">
        <div class="modal theme-picker" tabindex="-1">
          <h2 id="theme-picker-title"><span>Theme</span><span class="esc">⎋⎋ to cancel</span></h2>
          <div class="prompt theme-search">
            <span class="glyph">❯</span>
            <label class="sr-only" for="theme-q">Filter themes</label>
            <input id="theme-q" type="text" role="combobox" aria-controls="theme-list" aria-expanded="true" aria-autocomplete="list" autocomplete="off" autocapitalize="off" spellcheck="false">
          </div>
          <ul class="theme-list" id="theme-list" role="listbox" aria-label="Themes"></ul>
          <div class="modal-footer">
            <span id="theme-picker-hint"></span>
          </div>
        </div>
      </div>
    `;
  }

  function updateList() {
    const list = document.getElementById("theme-list");
    if (!list) return;
    if (filtered.length === 0) {
      list.innerHTML = `<li class="theme-item empty" role="presentation">No themes match "${escapeHTML(query)}"</li>`;
      document.getElementById("theme-q")?.removeAttribute("aria-activedescendant");
      return;
    }
    list.innerHTML = filtered.map((t, i) => {
      const isSelected = i === selectedIdx;
      const isActive = t.id === originalTheme;
      const activeLabel = isActive
        ? ' <span class="active-label">(active)</span>'
        : "";
      return `
        <li id="theme-option-${escapeHTML(t.id)}" class="theme-item" role="option" aria-selected="${isSelected}" data-theme-id="${escapeHTML(t.id)}">
          <span class="marker">▌</span>
          <div>
            <div class="theme-name">${escapeHTML(t.name)}${activeLabel}</div>
            <div class="theme-desc">${escapeHTML(t.description)}</div>
          </div>
        </li>
      `;
    }).join("");
    const sel = list.querySelector('[aria-selected="true"]');
    if (sel) {
      sel.scrollIntoView({ block: "nearest" });
      document.getElementById("theme-q")?.setAttribute("aria-activedescendant", sel.id);
    }
  }

  function updateHint() {
    const overlay = modalRoot.querySelector(".theme-picker-overlay");
    if (overlay) overlay.setAttribute("data-mode", mode);
    const hint = document.getElementById("theme-picker-hint");
    if (hint) {
      hint.textContent = mode === "insert"
        ? "type to filter · ↑↓ select · ⏎ apply · ⎋ normal mode"
        : "j/k select · ⏎ apply · i insert mode · ⎋ cancel";
    }
  }

  function setMode(m) {
    mode = m;
    const $input = document.getElementById("theme-q");
    if ($input) {
      if (m === "insert") $input.focus();
      else $input.blur();
    }
    updateHint();
  }

  function close() {
    document.removeEventListener("keydown", onKeydown, true);
    modalRoot.removeEventListener("input", onInput);
    modalRoot.removeEventListener("click", onClick);
    modalRoot.innerHTML = "";
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected) {
      returnFocus.focus();
    }
  }

  function navDown() {
    if (filtered.length === 0) return;
    selectedIdx = (selectedIdx + 1) % filtered.length;
    previewSelected();
    updateList();
  }
  function navUp() {
    if (filtered.length === 0) return;
    selectedIdx = (selectedIdx - 1 + filtered.length) % filtered.length;
    previewSelected();
    updateList();
  }

  function onKeydown(e) {
    if (e.key === "Tab") {
      e.preventDefault();
      setMode("insert");
      return;
    }
    // Esc cascade: insert → normal, normal → close (revert).
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (mode === "insert") setMode("normal");
      else {
        previewTheme(originalTheme);
        close();
      }
      return;
    }
    // Enter always applies (both modes).
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (filtered.length === 0) return;
      setTheme(filtered[selectedIdx].id);
      close();
      return;
    }
    // Arrows always nav (both modes).
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      navDown();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      navUp();
      return;
    }
    // Normal-mode chords.
    if (mode === "normal") {
      if (e.key === "Shift" || e.key === "Meta" || e.key === "Control" || e.key === "Alt") return;
      if (e.key === "j") { e.preventDefault(); e.stopPropagation(); navDown(); return; }
      if (e.key === "k") { e.preventDefault(); e.stopPropagation(); navUp(); return; }
      if (e.key === "i" || e.key === "/") {
        e.preventDefault();
        e.stopPropagation();
        setMode("insert");
        return;
      }
      // Swallow other keys in normal mode — the input is blurred but we want
      // to be defensive against the chord dispatcher behind us.
      e.stopPropagation();
      return;
    }
    // Insert mode: characters fall through to the focused input, which fires
    // its `input` event handled below.
  }

  function onInput(e) {
    if (!e.target || e.target.id !== "theme-q") return;
    query = e.target.value;
    applyFilter();
    selectedIdx = 0; // snap to top match on filter change
    clampSelected();
    previewSelected();
    updateList();
  }

  function onClick(e) {
    const li = e.target.closest && e.target.closest(".theme-item");
    if (!li) return;
    const id = li.getAttribute("data-theme-id");
    if (!id) return;
    setTheme(id);
    close();
  }

  buildShell();
  document.addEventListener("keydown", onKeydown, true);
  modalRoot.addEventListener("input", onInput);
  modalRoot.addEventListener("click", onClick);

  updateHint();
  updateList();
  previewSelected();
  // Focus the input now that the shell is in the DOM. Initial mode is insert.
  const $input = document.getElementById("theme-q");
  if ($input) {
    $input.addEventListener("focus", () => {
      if (mode !== "insert") {
        mode = "insert";
        updateHint();
      }
    });
    $input.focus();
  }
}
