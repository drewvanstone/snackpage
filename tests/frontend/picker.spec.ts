import { test, expect } from "@playwright/test";

test.describe("snackpage picker — load and render", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Wait for the picker to populate from /api/bookmarks
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length > 0,
      null,
      { timeout: 5_000 }
    );
    // Headless Chromium doesn't always honor autofocus the way a real
    // browser does. Real users land in insert mode; mirror that here.
    await page.locator("#q").focus();
  });

  test("loads 100 demo bookmarks", async ({ page }) => {
    const count = await page.locator("#list li").count();
    expect(count).toBe(100);
  });

  test("first row is selected by default", async ({ page }) => {
    const first = page.locator("#list li").first();
    await expect(first).toHaveAttribute("aria-selected", "true");
  });

  test("count text shows N/100", async ({ page }) => {
    const text = (await page.locator("#count").textContent()) ?? "";
    expect(text.trim()).toBe("100 / 100");
  });

  test("frecency-sorted on empty input: first row has high visit_count", async ({
    page,
  }) => {
    // The first row should be one of the more-frequently-visited bookmarks.
    // Demo seeding (rand seed 42) makes "frequent" bookmarks have 30-80 visits.
    // We can't pin a specific title without reading the same RNG roll, so
    // sanity-check: first row visits >= 10 (i.e. at least "regular" tier),
    // and last row's visits <= first row's visits.
    const firstVisits = await page
      .locator("#list li")
      .first()
      .locator(".count")
      .textContent();
    const lastVisits = await page
      .locator("#list li")
      .last()
      .locator(".count")
      .textContent();
    const firstN = parseInt(firstVisits?.match(/\d+/)?.[0] ?? "0", 10);
    const lastN = parseInt(lastVisits?.match(/\d+/)?.[0] ?? "0", 10);
    expect(firstN).toBeGreaterThanOrEqual(10);
    expect(firstN).toBeGreaterThanOrEqual(lastN);
  });
});
