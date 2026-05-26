// snackpage frontend — theme switcher.
//
// Sister module to the inline <head> bootstrap in index.html / manage.html.
// The bootstrap resolves the active theme before paint (URL param >
// localStorage > default) and appends the theme <link>; this module gives
// app.js and manage.js a runtime hook to swap themes from <Space>t.

export const THEMES = ["catppuccin-mocha", "classic-mac"];

export function currentTheme() {
  return document.documentElement.getAttribute("data-theme") || THEMES[0];
}

export function setTheme(name) {
  if (!THEMES.includes(name)) return;
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

export function cycleTheme() {
  const cur = currentTheme();
  const idx = THEMES.indexOf(cur);
  const next = THEMES[(idx + 1) % THEMES.length];
  setTheme(next);
  return next;
}
