// snackpage frontend — theme switcher.
//
// Sister module to the inline <head> bootstrap in index.html / manage.html.
// The bootstrap resolves the active theme before paint (URL param >
// localStorage > default) and appends the theme <link>; this module gives
// app.js and manage.js a runtime hook to swap themes from <Space>t (now via
// openThemePicker — a modal overlay with live preview).

// Theme registry. Each entry needs id (matches the CSS file under
// /static/themes/<id>.css and the data-theme attribute), a display name, and
// a one-line description for the picker overlay. Adding a theme = add an
// entry here + drop the CSS file.
export const THEMES = [
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    description: "Dark, mauve accents, modern",
  },
  {
    id: "classic-mac",
    name: "Classic Mac",
    description: "System-6 monochrome throwback",
  },
  { id: "dracula", name: "Dracula", description: "Iconic dark purple" },
  {
    id: "gruvbox-dark-medium",
    name: "Gruvbox Dark Medium",
    description: "Retro warm earth tones",
  },
  { id: "nord", name: "Nord", description: "Arctic blue and teal palette" },
  { id: "tokyo-night", name: "Tokyo Night", description: "Modern dark blue" },
  { id: "one-dark", name: "One Dark", description: "Atom's purple-blue classic" },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    description: "Ethan Schoonover high-contrast",
  },
  {
    id: "tomorrow-night",
    name: "Tomorrow Night",
    description: "Chris Kempson's signature",
  },
  { id: "monokai", name: "Monokai", description: "Sublime warm classic" },
  { id: "rose-pine", name: "Rose Pine", description: "Pastel pink/mauve modern" },
  {
    id: "everforest-dark",
    name: "Everforest Dark",
    description: "Green earth tones, Vim community favorite",
  },
  {
    id: "kanagawa",
    name: "Kanagawa",
    description: "Sumi-e Japanese painting inspired",
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    description: "Familiar GitHub aesthetic",
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    description: "Light sibling of Mocha",
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    description: "Classic light counterpart",
  },
  { id: "github-light", name: "GitHub Light", description: "GitHub daytime" },
  {
    id: "mono-light",
    name: "Mono Light",
    description: "Frosted-glass monochrome, IBM Plex Mono",
  },
];

export function currentTheme() {
  return (
    document.documentElement.getAttribute("data-theme") || THEMES[0].id
  );
}

// Apply theme to the DOM and persist the choice to localStorage. The picker
// overlay commits via this; the cancel path uses previewTheme() instead so
// the user's storage isn't touched.
export function setTheme(name) {
  if (!THEMES.find((t) => t.id === name)) return;
  document.documentElement.setAttribute("data-theme", name);
  localStorage.setItem("snackpageTheme", name);
  const link = document.getElementById("theme-css");
  if (link) {
    link.href = "/static/themes/" + name + ".css";
  } else {
    // Defensive: the bootstrap appended #theme-css before this module ran,
    // but if it isn't there (custom HTML, test harness, etc.) we recreate it.
    const fresh = document.createElement("link");
    fresh.rel = "stylesheet";
    fresh.id = "theme-css";
    fresh.href = "/static/themes/" + name + ".css";
    document.head.appendChild(fresh);
  }
}

// Same DOM updates as setTheme but does NOT save to localStorage. Used by
// the picker overlay to apply each theme as the user navigates without
// committing. Esc → revert via previewTheme(originalTheme) leaves storage
// untouched.
export function previewTheme(name) {
  if (!THEMES.find((t) => t.id === name)) return;
  document.documentElement.setAttribute("data-theme", name);
  const link = document.getElementById("theme-css");
  if (link) link.href = "/static/themes/" + name + ".css";
}

// Legacy cycle helper — no longer wired to <Space>t (the picker overlay
// took its place) but kept as a callable API for future tooling/extensions
// (URL params, e2e harnesses, etc.).
export function cycleTheme() {
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
      <div class="modal-overlay theme-picker-overlay" role="dialog" aria-label="Theme picker" data-mode="${mode}">
        <div class="modal theme-picker">
          <h2><span>Theme</span><span class="esc">⎋⎋ to cancel</span></h2>
          <div class="prompt theme-search">
            <span class="glyph">❯</span>
            <input id="theme-q" type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
          </div>
          <ul class="theme-list" id="theme-list" aria-live="polite"></ul>
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
      list.innerHTML = `<li class="theme-item empty">No themes match "${escapeHTML(query)}"</li>`;
      return;
    }
    list.innerHTML = filtered.map((t, i) => {
      const isSelected = i === selectedIdx;
      const isActive = t.id === originalTheme;
      const activeLabel = isActive
        ? ' <span class="active-label">(active)</span>'
        : "";
      return `
        <li class="theme-item" ${isSelected ? 'aria-selected="true"' : ""} data-theme-id="${escapeHTML(t.id)}">
          <span class="marker">▌</span>
          <div>
            <div class="theme-name">${escapeHTML(t.name)}${activeLabel}</div>
            <div class="theme-desc">${escapeHTML(t.description)}</div>
          </div>
        </li>
      `;
    }).join("");
    const sel = list.querySelector('[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ block: "nearest" });
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
    modalRoot.innerHTML = "";
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
  if ($input) $input.focus();
}
