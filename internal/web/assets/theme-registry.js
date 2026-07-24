// Shared, synchronous theme registry. This is loaded before theme-bootstrap.js
// so the initial theme can be validated and applied before the first paint.
(() => {
  const themes = [
    { id: "catppuccin-mocha", name: "Catppuccin Mocha", description: "Dark, mauve accents, modern" },
    { id: "classic-mac", name: "Classic Mac", description: "System-6 monochrome throwback" },
    { id: "dracula", name: "Dracula", description: "Iconic dark purple" },
    { id: "gruvbox-dark-medium", name: "Gruvbox Dark Medium", description: "Retro warm earth tones" },
    { id: "nord", name: "Nord", description: "Arctic blue and teal palette" },
    { id: "tokyo-night", name: "Tokyo Night", description: "Modern dark blue" },
    { id: "one-dark", name: "One Dark", description: "Atom's purple-blue classic" },
    { id: "solarized-dark", name: "Solarized Dark", description: "Ethan Schoonover high-contrast" },
    { id: "tomorrow-night", name: "Tomorrow Night", description: "Chris Kempson's signature" },
    { id: "monokai", name: "Monokai", description: "Sublime warm classic" },
    { id: "rose-pine", name: "Rose Pine", description: "Pastel pink/mauve modern" },
    { id: "everforest-dark", name: "Everforest Dark", description: "Green earth tones, Vim community favorite" },
    { id: "kanagawa", name: "Kanagawa", description: "Sumi-e Japanese painting inspired" },
    { id: "github-dark", name: "GitHub Dark", description: "Familiar GitHub aesthetic" },
    { id: "catppuccin-latte", name: "Catppuccin Latte", description: "Light sibling of Mocha" },
    { id: "solarized-light", name: "Solarized Light", description: "Classic light counterpart" },
    { id: "github-light", name: "GitHub Light", description: "GitHub daytime" },
    { id: "mono-light", name: "Mono Light", description: "Frosted-glass monochrome" },
  ].map(Object.freeze);

  Object.defineProperty(globalThis, "SnackpageThemes", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze(themes),
  });
})();
