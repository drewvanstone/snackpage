import { test, expect } from "@playwright/test";

test.describe("snackpage picker — load and render", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // beforeEach can't wait for #list li > 0 anymore — the list is empty by
    // design until the user types. Wait for the count text to populate instead,
    // which proves the page has fetched /api/bookmarks.
    await page.waitForFunction(
      () => document.getElementById("count")?.textContent !== "",
      null,
      { timeout: 5_000 }
    );
    // Headless Chromium doesn't always honor autofocus the way a real browser
    // does. Real users land in insert mode; mirror that here.
    await page.locator("#q").focus();
  });

  test("empty input renders no rows", async ({ page }) => {
    const count = await page.locator("#list li").count();
    expect(count).toBe(0);
  });

  test("count shows 0 / 100 initially (100 loaded but none rendered)", async ({
    page,
  }) => {
    const text = (await page.locator("#count").textContent()) ?? "";
    expect(text.trim()).toBe("0 / 100");
  });

  test("typing reveals matching rows", async ({ page }) => {
    await page.locator("#q").fill("github");
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length > 0
    );
    const count = await page.locator("#list li").count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(100);
  });

  test("backspacing to empty hides the list again", async ({ page }) => {
    await page.locator("#q").fill("github");
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length > 0
    );
    await page.locator("#q").fill("");
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length === 0
    );
    expect(await page.locator("#list li").count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// v1.7 — theming
//
// Theme resolution is inlined in <head> ahead of style.css to avoid FOUC:
//   priority: ?theme=X > localStorage.snackpageTheme > "catppuccin-mocha"
// ?theme=X persists to localStorage; <Space>t cycles via theme.js.
// ---------------------------------------------------------------------------

test.describe("snackpage picker — theming", () => {
  test.beforeEach(async ({ page }) => {
    // Each test starts from a clean theme slate so prior tests don't leak
    // localStorage into later runs.
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("snackpageTheme"));
  });

  test("default theme is catppuccin-mocha", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "catppuccin-mocha",
    );
  });

  test("?theme=classic-mac applies on load and persists across reload", async ({
    page,
  }) => {
    await page.goto("/?theme=classic-mac");
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "classic-mac",
    );

    const stored = await page.evaluate(() =>
      localStorage.getItem("snackpageTheme"),
    );
    expect(stored).toBe("classic-mac");

    // Reload WITHOUT the query param — choice should persist via localStorage.
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "classic-mac",
    );

    // Cleanup so later tests don't see a non-default theme.
    await page.evaluate(() => localStorage.removeItem("snackpageTheme"));
  });

  test("<Space>t cycles themes from normal mode", async ({ page }) => {
    // Start from a clean default. Reload after clearing storage so the
    // bootstrap re-resolves and lands on catppuccin-mocha.
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("snackpageTheme"));
    await page.reload();
    await page.waitForFunction(
      () => document.getElementById("count")?.textContent !== "",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "catppuccin-mocha",
    );

    // Drop into normal mode (the picker autofocuses the input → insert mode).
    await page.locator("#q").focus();
    await page.keyboard.press("Escape");
    await expect(page.locator("#picker")).toHaveAttribute("data-mode", "normal");

    // <Space>t cycles → classic-mac.
    await page.keyboard.press("Space");
    await page.keyboard.press("t");
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "classic-mac",
    );

    // Cycle again → back to catppuccin-mocha.
    await page.keyboard.press("Space");
    await page.keyboard.press("t");
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "catppuccin-mocha",
    );

    // Cleanup.
    await page.evaluate(() => localStorage.removeItem("snackpageTheme"));
  });
});
