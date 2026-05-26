import { test, expect } from "@playwright/test";

// Open the theme picker via the Space-t chord. The chord lives in
// KEYMAP_NORMAL, so we Esc to normal first.
async function openThemePicker(page) {
  await page.keyboard.press("Escape");
  await expect(page.locator("#picker")).toHaveAttribute("data-mode", "normal");
  await page.keyboard.press(" ");
  await page.keyboard.press("t");
  await expect(page.locator(".theme-picker-overlay")).toBeVisible();
}

test.describe("snackpage theme picker", () => {
  test.beforeEach(async ({ page }) => {
    // Pin the active theme so individual tests have a known starting point and
    // don't bleed state from prior test runs. localStorage survives across
    // tests inside the same browser context.
    await page.addInitScript(() =>
      localStorage.setItem("snackpageTheme", "catppuccin-mocha"),
    );
    await page.goto("/");
    await page.waitForFunction(
      () => document.getElementById("count")?.textContent !== "",
      null,
      { timeout: 5_000 },
    );
    await page.locator("#q").focus();
  });

  test("opens in insert mode with search input focused and full list visible", async ({
    page,
  }) => {
    await openThemePicker(page);
    await expect(page.locator(".theme-picker-overlay")).toHaveAttribute(
      "data-mode",
      "insert",
    );
    const focusedId = await page.evaluate(
      () => document.activeElement?.id ?? "",
    );
    expect(focusedId).toBe("theme-q");
    // 17 themes ship today; we just assert the picker shows more than a couple.
    const count = await page.locator(".theme-item:not(.empty)").count();
    expect(count).toBeGreaterThanOrEqual(15);
  });

  test("typing filters the list and selects the top match", async ({ page }) => {
    await openThemePicker(page);
    const total = await page.locator(".theme-item:not(.empty)").count();
    await page.locator("#theme-q").pressSequentially("dracula");
    // fzf is non-contiguous so multiple themes may match a sequence of
    // characters, but the count should shrink and Dracula must be the top
    // (selected) match.
    const filteredCount = await page.locator(".theme-item:not(.empty)").count();
    expect(filteredCount).toBeLessThan(total);
    const selectedId = await page
      .locator('.theme-item[aria-selected="true"]')
      .getAttribute("data-theme-id");
    expect(selectedId).toBe("dracula");
  });

  test("empty filter shows a placeholder row and Enter is a no-op", async ({
    page,
  }) => {
    await openThemePicker(page);
    await page.locator("#theme-q").pressSequentially("zzzzzzzz");
    await expect(page.locator(".theme-item.empty")).toBeVisible();
    // Enter should not close the picker when there's nothing to apply.
    await page.keyboard.press("Enter");
    await expect(page.locator(".theme-picker-overlay")).toBeVisible();
  });

  test("Enter applies the selected theme and persists to localStorage", async ({
    page,
  }) => {
    await openThemePicker(page);
    await page.locator("#theme-q").pressSequentially("drac");
    await page.keyboard.press("Enter");
    await expect(page.locator(".theme-picker-overlay")).toHaveCount(0);
    const persisted = await page.evaluate(() =>
      localStorage.getItem("snackpageTheme"),
    );
    expect(persisted).toBe("dracula");
    const dataTheme = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme"),
    );
    expect(dataTheme).toBe("dracula");
  });

  test("Esc from insert switches to normal mode; j/k navigates there", async ({
    page,
  }) => {
    await openThemePicker(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".theme-picker-overlay")).toHaveAttribute(
      "data-mode",
      "normal",
    );
    // The starting selection should be the active theme (catppuccin-mocha,
    // index 0). j moves down to classic-mac.
    await page.keyboard.press("j");
    const after = await page
      .locator('.theme-item[aria-selected="true"]')
      .getAttribute("data-theme-id");
    expect(after).toBe("classic-mac");
  });

  test("`i` from normal returns to insert and refocuses the search", async ({
    page,
  }) => {
    await openThemePicker(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press("i");
    await expect(page.locator(".theme-picker-overlay")).toHaveAttribute(
      "data-mode",
      "insert",
    );
    const focusedId = await page.evaluate(
      () => document.activeElement?.id ?? "",
    );
    expect(focusedId).toBe("theme-q");
  });

  test("Esc from normal closes the picker and reverts the preview", async ({
    page,
  }) => {
    await openThemePicker(page);
    // Type to filter + select dracula. This live-previews dracula on the page.
    await page.locator("#theme-q").pressSequentially("drac");
    expect(
      await page.evaluate(() =>
        document.documentElement.getAttribute("data-theme"),
      ),
    ).toBe("dracula");
    // Two Escapes: insert → normal → close.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.locator(".theme-picker-overlay")).toHaveCount(0);
    // Page should be back to the pre-overlay theme. Nothing in localStorage.
    expect(
      await page.evaluate(() =>
        document.documentElement.getAttribute("data-theme"),
      ),
    ).toBe("catppuccin-mocha");
    expect(
      await page.evaluate(() => localStorage.getItem("snackpageTheme")),
    ).toBe("catppuccin-mocha");
  });

  test("theme list caps at 320px and scrolls when overflowing", async ({
    page,
  }) => {
    await openThemePicker(page);
    const list = page.locator(".theme-list");
    const box = await list.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThanOrEqual(320);
    // 17 themes at ~50px each ≈ 850px of content; we expect scrollHeight to
    // exceed clientHeight, proving the cap is engaged.
    const overflow = await list.evaluate(
      (el: HTMLElement) => el.scrollHeight - el.clientHeight,
    );
    expect(overflow).toBeGreaterThan(0);
  });
});
