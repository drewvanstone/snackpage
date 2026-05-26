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

  test("<Space>t opens theme picker with active theme highlighted", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("snackpageTheme"));
    await page.reload();
    await page.locator("#q").focus();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Space");
    await page.keyboard.press("t");

    const overlay = page.locator(".theme-picker-overlay");
    await expect(overlay).toBeVisible();
    // The catppuccin-mocha row should be aria-selected
    await expect(overlay.locator('.theme-item[data-theme-id="catppuccin-mocha"]'))
      .toHaveAttribute("aria-selected", "true");
  });

  test("j/k in theme picker live-previews each theme", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("snackpageTheme"));
    await page.reload();
    await page.locator("#q").focus();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Space");
    await page.keyboard.press("t");

    // Initially data-theme is catppuccin-mocha
    await expect(page.locator("html")).toHaveAttribute("data-theme", "catppuccin-mocha");

    // j moves selection down → classic-mac → preview applies
    await page.keyboard.press("j");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "classic-mac");

    // localStorage NOT yet updated (preview only)
    const stored = await page.evaluate(() => localStorage.getItem("snackpageTheme"));
    expect(stored).toBeNull();
  });

  test("Enter in theme picker commits the highlighted theme", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("snackpageTheme"));
    await page.reload();
    await page.locator("#q").focus();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Space");
    await page.keyboard.press("t");
    await page.keyboard.press("j"); // → classic-mac preview
    await page.keyboard.press("Enter"); // commit

    await expect(page.locator(".theme-picker-overlay")).not.toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "classic-mac");
    const stored = await page.evaluate(() => localStorage.getItem("snackpageTheme"));
    expect(stored).toBe("classic-mac");

    // Cleanup
    await page.evaluate(() => localStorage.removeItem("snackpageTheme"));
  });

  test("Esc in theme picker reverts to pre-overlay theme", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("snackpageTheme"));
    await page.reload();
    await page.locator("#q").focus();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Space");
    await page.keyboard.press("t");
    await page.keyboard.press("j"); // preview classic-mac
    await expect(page.locator("html")).toHaveAttribute("data-theme", "classic-mac");

    await page.keyboard.press("Escape"); // cancel → revert
    await expect(page.locator(".theme-picker-overlay")).not.toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "catppuccin-mocha");
    const stored = await page.evaluate(() => localStorage.getItem("snackpageTheme"));
    expect(stored).toBeNull();
  });

  test("every theme in the THEMES array loads via ?theme= and applies", async ({ page }) => {
    // Read the full list from the running app to stay in sync with theme.js
    await page.goto("/");
    const ids = await page.evaluate(async () => {
      const mod = await import("/static/theme.js");
      return mod.THEMES.map((t) => t.id);
    });
    expect(ids.length).toBe(17);

    for (const id of ids) {
      await page.goto(`/?theme=${id}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", id);
      const linkHref = await page.locator("#theme-css").getAttribute("href");
      expect(linkHref).toContain(`themes/${id}.css`);
      // Sanity: at least the prompt glyph has a non-empty color set
      const glyphColor = await page
        .locator(".prompt .glyph")
        .evaluate((el) => getComputedStyle(el).color);
      expect(glyphColor).toMatch(/rgb/);
    }

    // Cleanup
    await page.evaluate(() => localStorage.removeItem("snackpageTheme"));
  });
});
