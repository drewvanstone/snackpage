// Resolve and apply the theme synchronously, before base CSS is loaded.
(() => {
  const themes = globalThis.SnackpageThemes || [];
  const defaultTheme = themes[0]?.id || "catppuccin-mocha";
  const allowed = new Set(themes.map((theme) => theme.id));
  const params = new URLSearchParams(location.search);
  const requested = params.get("theme");
  let stored = null;
  try {
    stored = localStorage.getItem("snackpageTheme");
  } catch {
    // Storage may be unavailable in privacy-restricted/embedded contexts.
    // Theme selection should still work for the current page.
  }

  let theme = defaultTheme;
  if (requested && allowed.has(requested)) {
    theme = requested;
    try {
      localStorage.setItem("snackpageTheme", theme);
    } catch {
      // Applying the requested theme does not depend on persistence.
    }
  } else if (stored && allowed.has(stored)) {
    theme = stored;
  } else if (stored) {
    try {
      localStorage.removeItem("snackpageTheme");
    } catch {
      // Ignore an unavailable store and continue with the safe default.
    }
  }

  document.documentElement.dataset.theme = theme;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.id = "theme-css";
  const version = document.currentScript?.dataset.version || "";
  link.href = `/static/themes/${theme}.css${version ? `?v=${encodeURIComponent(version)}` : ""}`;
  document.head.appendChild(link);
})();
