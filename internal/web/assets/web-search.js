// Web-search provider registry. Google is the only configured choice today,
// but picker rendering and navigation depend on this provider shape rather
// than a Google-specific branch.
export const WEB_SEARCH_PROVIDERS = Object.freeze({
  google: Object.freeze({
    id: "google",
    name: "Google",
    displayHost: "google.com",
    buildURL: (query) =>
      `https://www.google.com/search?q=${encodeURIComponent(query)}`,
  }),
});

export const DEFAULT_WEB_SEARCH_PROVIDER_ID = "google";

export function getWebSearchProvider(id = DEFAULT_WEB_SEARCH_PROVIDER_ID) {
  return WEB_SEARCH_PROVIDERS[id] || null;
}
