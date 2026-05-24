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
