import { expect, test, type BrowserContext, type Page } from "@playwright/test";

type Bookmark = {
  id: string;
  title: string;
  url: string;
  tags: string[];
  aliases: string[];
  visit_count: number;
  last_visit_at: string | null;
  frecency_score: number;
};

type APICall = {
  method: string;
  url: string;
};

const WEB_SEARCH_SELECTOR =
  '#web-search-option-google[data-result-kind="web-search"][data-search-provider="google"]';

function bookmark(id: string, title: string, url: string): Bookmark {
  return {
    id,
    title,
    url,
    tags: [],
    aliases: [],
    visit_count: 0,
    last_visit_at: null,
    frecency_score: 0,
  };
}

function googleSearchURL(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query.trim())}`;
}

function googleSearchLabel(query: string): string {
  return `Search Google for “${query.trim()}”`;
}

function webSearchOption(page: Page) {
  return page.locator(WEB_SEARCH_SELECTOR);
}

async function openPicker(
  page: Page,
  bookmarks: Bookmark[],
): Promise<APICall[]> {
  const apiCalls: APICall[] = [];

  await page.route("**/api/bookmarks", async (route) => {
    const request = route.request();
    apiCalls.push({ method: request.method(), url: request.url() });

    if (request.method() !== "GET") {
      await route.fulfill({
        status: 405,
        contentType: "application/json",
        body: JSON.stringify({ error: "bookmark mutations are not expected" }),
      });
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ bookmarks }),
    });
  });

  await page.goto("/");
  await expect(page.locator("#count")).toHaveText(`0 / ${bookmarks.length}`);
  await page.getByRole("combobox", { name: "Search bookmarks" }).focus();
  return apiCalls;
}

async function stubGoogle(context: BrowserContext): Promise<void> {
  await context.route("https://www.google.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Google search stub</title>",
    }),
  );
}

test.describe("snackpage picker — Google web-search action", () => {
  test("a non-empty query appends an accessible Google option after bookmark matches", async ({
    page,
  }) => {
    const bookmarks = [
      bookmark(
        "ATLAS001",
        "Project Atlas Docs",
        "https://docs.example.test/atlas",
      ),
      bookmark(
        "ATLAS002",
        "Project Atlas Status",
        "https://status.example.test/atlas",
      ),
    ];
    await openPicker(page, bookmarks);

    const queryText = "project atlas";
    const query = page.getByRole("combobox", { name: "Search bookmarks" });
    await query.fill(queryText);

    const options = page.getByRole("option");
    const bookmarkOptions = page.locator('#list li[data-id]');
    const searchOption = webSearchOption(page);

    await expect(bookmarkOptions).toHaveCount(2);
    await expect(options).toHaveCount(3);
    await expect(options.last()).toHaveAttribute(
      "id",
      "web-search-option-google",
    );
    await expect(searchOption).toHaveAttribute(
      "aria-label",
      googleSearchLabel(queryText),
    );
    await expect(searchOption).toHaveAttribute("aria-selected", "false");
    await expect(bookmarkOptions.first()).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(query).toHaveAttribute(
      "aria-activedescendant",
      await bookmarkOptions.first().getAttribute("id"),
    );
    await expect(page.locator("#count")).toHaveText("2 / 2");
  });

  test("@smoke a query without bookmark matches selects the Google option", async ({
    page,
  }) => {
    await openPicker(page, [
      bookmark("OTHER001", "Unrelated Bookmark", "https://example.test"),
    ]);

    const queryText = "no local result";
    const query = page.getByRole("combobox", { name: "Search bookmarks" });
    await query.fill(queryText);

    const searchOption = webSearchOption(page);
    await expect(page.locator('#list li[data-id]')).toHaveCount(0);
    await expect(page.getByRole("option")).toHaveCount(1);
    await expect(searchOption).toHaveAttribute(
      "aria-label",
      googleSearchLabel(queryText),
    );
    await expect(searchOption).toHaveAttribute("aria-selected", "true");
    await expect(query).toHaveAttribute(
      "aria-activedescendant",
      "web-search-option-google",
    );
    await expect(page.locator("#count")).toHaveText("0 / 1");
  });

  test("ArrowUp wraps from the first bookmark to Google and ArrowDown returns", async ({
    page,
  }) => {
    await openPicker(page, [
      bookmark(
        "WRAP0001",
        "Wrap Navigation Notes",
        "https://wrap.example.test",
      ),
    ]);

    const query = page.getByRole("combobox", { name: "Search bookmarks" });
    const bookmarkOption = page.locator('#list li[data-id="WRAP0001"]');
    const searchOption = webSearchOption(page);
    await query.fill("wrap navigation");
    await expect(bookmarkOption).toHaveAttribute("aria-selected", "true");

    await query.press("ArrowUp");
    await expect(searchOption).toHaveAttribute("aria-selected", "true");
    await expect(bookmarkOption).toHaveAttribute("aria-selected", "false");
    await expect(query).toHaveAttribute(
      "aria-activedescendant",
      "web-search-option-google",
    );

    await query.press("ArrowDown");
    await expect(bookmarkOption).toHaveAttribute("aria-selected", "true");
    await expect(searchOption).toHaveAttribute("aria-selected", "false");
    await expect(query).toHaveAttribute(
      "aria-activedescendant",
      "bookmark-option-WRAP0001",
    );
  });

  test("an empty or whitespace-only query has no Google option", async ({
    page,
  }) => {
    await openPicker(page, [
      bookmark("EMPTY001", "Any Bookmark", "https://example.test"),
    ]);

    const query = page.getByRole("combobox", { name: "Search bookmarks" });
    await expect(webSearchOption(page)).toHaveCount(0);

    await query.fill("   ");
    await expect(webSearchOption(page)).toHaveCount(0);
    await expect(page.getByRole("option")).toHaveCount(0);
    await expect(query).toHaveAttribute("aria-expanded", "false");
    await expect(query).not.toHaveAttribute("aria-activedescendant");
  });

  test("Enter on the selected Google option navigates the current tab with an encoded query", async ({
    context,
    page,
  }) => {
    await stubGoogle(context);
    const apiCalls = await openPicker(page, []);
    const queryText = "cats & dogs/100%?";
    const destination = googleSearchURL(queryText);

    const query = page.getByRole("combobox", { name: "Search bookmarks" });
    await query.fill(queryText);
    await expect(webSearchOption(page)).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await Promise.all([
      page.waitForURL(destination),
      query.press("Enter"),
    ]);

    expect(page.url()).toBe(destination);
    expect(apiCalls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  test("Ctrl+Enter opens the selected Google option in a new tab without changing bookmark data", async ({
    context,
    page,
  }) => {
    await stubGoogle(context);
    const bookmarks = [
      bookmark("KEEP0001", "Keep Me", "https://keep.example.test"),
    ];
    const apiCalls = await openPicker(page, bookmarks);
    const pickerURL = page.url();
    const queryText = "open this separately";
    const destination = googleSearchURL(queryText);

    const query = page.getByRole("combobox", { name: "Search bookmarks" });
    await query.fill(queryText);
    const newPagePromise = context.waitForEvent("page");
    await query.press("Control+Enter");
    const searchPage = await newPagePromise;

    await expect(searchPage).toHaveURL(destination);
    expect(page.url()).toBe(pickerURL);

    const after = await page.evaluate(async () => {
      const response = await fetch("/api/bookmarks");
      return response.json();
    });
    expect(after).toEqual({ bookmarks });
    expect(apiCalls.filter((call) => call.method !== "GET")).toEqual([]);

    await searchPage.close();
  });

  test("pointer hover selects the Google option and click opens it", async ({
    context,
    page,
  }) => {
    await stubGoogle(context);
    await openPicker(page, [
      bookmark(
        "POINTER1",
        "Pointer Search Notes",
        "https://notes.example.test/pointer",
      ),
    ]);
    const queryText = "pointer search";
    const destination = googleSearchURL(queryText);
    const query = page.getByRole("combobox", { name: "Search bookmarks" });
    await query.fill(queryText);

    const bookmarkOption = page.locator('#list li[data-id]');
    const searchOption = webSearchOption(page);
    await expect(bookmarkOption).toHaveAttribute("aria-selected", "true");

    await searchOption.hover();
    await expect(searchOption).toHaveAttribute("aria-selected", "true");
    await expect(bookmarkOption).toHaveAttribute("aria-selected", "false");
    await expect(query).toHaveAttribute(
      "aria-activedescendant",
      "web-search-option-google",
    );

    await Promise.all([
      page.waitForURL(destination),
      searchOption.click(),
    ]);
    expect(page.url()).toBe(destination);
  });

  test("Enter still opens the selected bookmark when local matches exist", async ({
    page,
  }) => {
    await page.route("**/go/*", (route) => route.fulfill({ status: 204 }));
    await openPicker(page, [
      bookmark(
        "LOCAL001",
        "Local Search Result",
        "https://local.example.test",
      ),
    ]);

    const query = page.getByRole("combobox", { name: "Search bookmarks" });
    await query.fill("local search");
    await expect(page.locator('#list li[data-id="LOCAL001"]')).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(webSearchOption(page)).toHaveAttribute(
      "aria-selected",
      "false",
    );

    const bookmarkOpen = page.waitForRequest((request) =>
      request.url().endsWith("/go/LOCAL001"),
    );
    await query.press("Enter");
    await bookmarkOpen;
  });
});
