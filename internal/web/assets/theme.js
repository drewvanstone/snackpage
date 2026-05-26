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

// Open a modal theme picker. j/k navigates and live-previews; Enter commits
// (persists to localStorage); Esc reverts to the pre-overlay theme and
// closes without writing. Same picker works in both the picker view and the
// manage view (each has #modal-root).
//
// The overlay uses class .modal-overlay so app.js / manage.js's chord
// dispatcher bails on its presence (same pattern as the Add/Edit and Help
// modals).
export function openThemePicker() {
  const modalRoot = document.getElementById("modal-root");
  if (!modalRoot) return;

  const originalTheme = currentTheme();
  let selectedIdx = THEMES.findIndex((t) => t.id === originalTheme);
  if (selectedIdx < 0) selectedIdx = 0;

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
    );
  }

  function render() {
    const items = THEMES.map((t, i) => {
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
    modalRoot.innerHTML = `
      <div class="modal-overlay theme-picker-overlay" role="dialog" aria-label="Theme picker">
        <div class="modal theme-picker">
          <h2><span>Theme</span><span class="esc">⎋ to cancel</span></h2>
          <ul class="theme-list">${items}</ul>
          <div class="modal-footer">
            <span>j/k select · ⏎ apply · ⎋ cancel</span>
          </div>
        </div>
      </div>
    `;
  }

  function close() {
    document.removeEventListener("keydown", onKeydown, true);
    modalRoot.innerHTML = "";
  }

  function onKeydown(e) {
    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      selectedIdx = (selectedIdx + 1) % THEMES.length;
      previewTheme(THEMES[selectedIdx].id);
      render();
      return;
    }
    if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      selectedIdx = (selectedIdx - 1 + THEMES.length) % THEMES.length;
      previewTheme(THEMES[selectedIdx].id);
      render();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      setTheme(THEMES[selectedIdx].id);
      close();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      previewTheme(originalTheme);
      close();
      return;
    }
  }

  // Capture phase so we override the page-level chord dispatcher.
  document.addEventListener("keydown", onKeydown, true);
  // Apply the active theme as the starting preview (no-op since it's already
  // applied, but keeps the invariant that previewTheme is what controls the
  // visible theme during the overlay's lifetime).
  previewTheme(THEMES[selectedIdx].id);
  render();
}
