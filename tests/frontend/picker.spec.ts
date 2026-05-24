import { test, expect } from "@playwright/test";

test.describe("snackpage picker (smoke)", () => {
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

  test("loads and renders the demo bookmarks", async ({ page }) => {
    const count = await page.locator("#list li").count();
    expect(count).toBe(100);
    // First row should be visually selected
    const first = page.locator("#list li").first();
    await expect(first).toHaveAttribute("aria-selected", "true");
  });

  test("fuzzy search filters the list", async ({ page }) => {
    await page.locator("#q").fill("github");
    // List should still have entries; at least one should mention GitHub
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length > 0
    );
    const titles = await page.locator("#list .title").allTextContents();
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.length).toBeLessThan(100);
    expect(
      titles.some((t) => t.toLowerCase().includes("github"))
    ).toBeTruthy();
  });

  test("Esc enters normal mode, i returns to insert", async ({ page }) => {
    const picker = page.locator("#picker");
    await expect(picker).toHaveAttribute("data-mode", "insert");

    await page.keyboard.press("Escape");
    await expect(picker).toHaveAttribute("data-mode", "normal");

    await page.keyboard.press("i");
    await expect(picker).toHaveAttribute("data-mode", "insert");
  });

  test("j/k navigates in normal mode", async ({ page }) => {
    await page.keyboard.press("Escape"); // enter normal
    const initialId = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");

    await page.keyboard.press("j");
    const afterJ = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");
    expect(afterJ).not.toBe(initialId);

    await page.keyboard.press("k");
    const afterK = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");
    expect(afterK).toBe(initialId);
  });

  test("Enter on a row hits /go/:id (302 redirect)", async ({ page }) => {
    // Find the currently selected row's id
    const id = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");
    expect(id).toBeTruthy();

    // Intercept the redirect: navigate via window.location and check the request URL
    const requestPromise = page.waitForRequest(
      (req) => req.url().includes(`/go/${id}`)
    );
    await page.keyboard.press("Enter");
    const req = await requestPromise;
    expect(req.url()).toContain(`/go/${id}`);
  });
});
