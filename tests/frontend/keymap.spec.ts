import { test, expect } from "@playwright/test";

test.describe("snackpage picker — keymap and modes", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length > 0,
      null,
      { timeout: 5_000 }
    );
    await page.locator("#q").focus();
  });

  test("Esc enters normal, i returns to insert", async ({ page }) => {
    const picker = page.locator("#picker");
    await expect(picker).toHaveAttribute("data-mode", "insert");

    await page.keyboard.press("Escape");
    await expect(picker).toHaveAttribute("data-mode", "normal");

    await page.keyboard.press("i");
    await expect(picker).toHaveAttribute("data-mode", "insert");
  });

  test("data-mode attribute reflects current mode", async ({ page }) => {
    const picker = page.locator("#picker");
    await expect(picker).toHaveAttribute("data-mode", "insert");
    await page.keyboard.press("Escape");
    await expect(picker).toHaveAttribute("data-mode", "normal");
    await page.keyboard.press("a");
    await expect(picker).toHaveAttribute("data-mode", "insert");
  });

  test("prompt glyph color changes with mode", async ({ page }) => {
    const glyph = page.locator(".prompt .glyph");
    // Insert: yellow (#f9e2af → rgb(249, 226, 175))
    const insertColor = await glyph.evaluate(
      (el) => getComputedStyle(el).color
    );
    expect(insertColor).toBe("rgb(249, 226, 175)");

    await page.keyboard.press("Escape");
    // Normal: mauve (#cba6f7 → rgb(203, 166, 247))
    const normalColor = await glyph.evaluate(
      (el) => getComputedStyle(el).color
    );
    expect(normalColor).toBe("rgb(203, 166, 247)");
  });

  test("footer hints change with mode", async ({ page }) => {
    const hints = page.locator("#hints");

    // Insert mode: should mention "⎋ normal"
    const insertText = (await hints.textContent()) ?? "";
    expect(insertText).toContain("⎋ normal");
    expect(insertText).not.toContain("j/k");

    await page.keyboard.press("Escape");

    // Normal mode: should mention "i insert" and "j/k"
    const normalText = (await hints.textContent()) ?? "";
    expect(normalText).toContain("i insert");
    expect(normalText).toContain("j/k");
    expect(normalText).not.toContain("⎋ normal");
  });

  test("j/k navigates only in normal mode", async ({ page }) => {
    // Insert mode: typing "j" populates the input, not navigation.
    const initialId = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");
    await page.keyboard.press("j");
    // Input should now contain "j"
    await expect(page.locator("#q")).toHaveValue("j");

    // Clear and enter normal mode
    await page.locator("#q").fill("");
    await page.keyboard.press("Escape");
    await expect(page.locator("#picker")).toHaveAttribute(
      "data-mode",
      "normal"
    );

    // Refresh — selection may have shifted due to filter clearing; recapture
    const beforeJ = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");
    await page.keyboard.press("j");
    const afterJ = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");
    expect(afterJ).not.toBe(beforeJ);

    await page.keyboard.press("k");
    const afterK = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");
    expect(afterK).toBe(beforeJ);

    // Initial reference is used so eslint doesn't complain about unused var.
    expect(initialId).toBeTruthy();
  });

  test("arrow keys navigate in both modes", async ({ page }) => {
    // Insert mode
    const insertStart = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");
    await page.keyboard.press("ArrowDown");
    const afterDown = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");
    expect(afterDown).not.toBe(insertStart);
    await page.keyboard.press("ArrowUp");
    const afterUp = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");
    expect(afterUp).toBe(insertStart);

    // Normal mode
    await page.keyboard.press("Escape");
    const normalStart = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");
    await page.keyboard.press("ArrowDown");
    const normalDown = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");
    expect(normalDown).not.toBe(normalStart);
  });

  test("Ctrl+N / Ctrl+P navigate in both modes", async ({ page }) => {
    const start = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");
    await page.keyboard.press("Control+n");
    const afterN = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");
    expect(afterN).not.toBe(start);
    await page.keyboard.press("Control+p");
    const afterP = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");
    expect(afterP).toBe(start);

    // And in normal mode
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+n");
    const normalAfterN = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");
    expect(normalAfterN).not.toBe(start);
  });

  test("/ focuses input from normal mode and re-enters insert", async ({
    page,
  }) => {
    await page.keyboard.press("Escape");
    await expect(page.locator("#picker")).toHaveAttribute(
      "data-mode",
      "normal"
    );
    await page.keyboard.press("/");
    await expect(page.locator("#picker")).toHaveAttribute(
      "data-mode",
      "insert"
    );
    // Focus should be on the input
    const focusedId = await page.evaluate(
      () => document.activeElement?.id ?? ""
    );
    expect(focusedId).toBe("q");
  });

  test("search filters by title", async ({ page }) => {
    await page.locator("#q").fill("github");
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

  test("search filters by tag", async ({ page }) => {
    await page.locator("#q").fill("shopping");
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length > 0
    );
    const titles = await page.locator("#list .title").allTextContents();
    expect(titles.length).toBeGreaterThan(0);
    // Demo data has Amazon, eBay, Etsy, Walmart, etc. tagged "shopping"
    expect(
      titles.some((t) =>
        ["amazon", "ebay", "etsy", "walmart", "target"].includes(t.toLowerCase())
      )
    ).toBeTruthy();
  });

  test("search no-match returns empty list", async ({ page }) => {
    await page.locator("#q").fill("qqqxyz");
    // List should empty out. Wait briefly for the input handler.
    await expect(page.locator("#list li")).toHaveCount(0);
  });

  test("Enter on selected row hits /go/:id", async ({ page }) => {
    const id = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");
    expect(id).toBeTruthy();
    const requestPromise = page.waitForRequest((req) =>
      req.url().includes(`/go/${id}`)
    );
    await page.keyboard.press("Enter");
    const req = await requestPromise;
    expect(req.url()).toContain(`/go/${id}`);
  });
});
