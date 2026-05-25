import { test, expect } from "@playwright/test";

// Pull the "N" out of a "K / N" count-text string. The list total grows when
// other tests add bookmarks in parallel, so tests that care about the delta
// should poll this rather than asserting a fixed value.
function parseTotal(text: string | null | undefined): number {
  const m = (text ?? "").match(/\/\s*(\d+)/);
  return m ? parseInt(m[1], 10) : NaN;
}

// Open the Add modal via the v1.4 chord: Esc → normal → a.
async function openAddModal(page) {
  await page.keyboard.press("Escape");
  await expect(page.locator("#picker")).toHaveAttribute("data-mode", "normal");
  await page.keyboard.press("a");
  await expect(page.locator(".modal-overlay")).toBeVisible();
}

test.describe("snackpage picker — modal flows", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // List is empty by default — wait for the count text to populate as proof
    // that /api/bookmarks has loaded. Individual tests type when they need rows.
    await page.waitForFunction(
      () => document.getElementById("count")?.textContent !== "",
      null,
      { timeout: 5_000 }
    );
    await page.locator("#q").focus();
  });

  test("'a' in normal mode opens Add modal with URL field focused", async ({
    page,
  }) => {
    await openAddModal(page);
    const focusedId = await page.evaluate(
      () => document.activeElement?.id ?? ""
    );
    expect(focusedId).toBe("m-url");
  });

  test("Esc inside modal cancels (no list change)", async ({ page }) => {
    const beforeCount = await page.locator("#list li").count();
    await openAddModal(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".modal-overlay")).toHaveCount(0);
    const afterCount = await page.locator("#list li").count();
    expect(afterCount).toBe(beforeCount);
  });

  test("Enter with valid URL submits and adds to list", async ({ page }) => {
    // Capture the bookmarks-loaded total before the add. Empty input renders
    // 0 rows so we read it from the right side of "0 / N" in the count text.
    const before = parseTotal(await page.locator("#count").textContent());
    await openAddModal(page);
    await page.locator("#m-url").fill("https://example.test/new-bookmark");
    await page.locator("#m-title").fill("Example Test Bookmark");
    await page.keyboard.press("Enter");
    // Modal should close
    await expect(page.locator(".modal-overlay")).toHaveCount(0);
    // The list-total in the footer should grow by 1 (still 0 rendered).
    await expect
      .poll(async () => parseTotal(await page.locator("#count").textContent()))
      .toBe(before + 1);
    // Type the new title to reveal the row.
    await page.locator("#q").fill("Example Test Bookmark");
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length > 0
    );
    const titles = await page.locator("#list .title").allTextContents();
    expect(titles).toContain("Example Test Bookmark");
  });

  test("blank title defaults to URL hostname on submit", async ({ page }) => {
    const before = parseTotal(await page.locator("#count").textContent());
    await openAddModal(page);
    await page.locator("#m-url").fill("https://hostname-default.example/path");
    // leave title blank
    await page.locator("#m-title").fill("");
    await page.keyboard.press("Enter");
    await expect(page.locator(".modal-overlay")).toHaveCount(0);
    await expect
      .poll(async () => parseTotal(await page.locator("#count").textContent()))
      .toBe(before + 1);
    // Type the expected hostname to reveal the new row.
    await page.locator("#q").fill("hostname-default");
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length > 0
    );
    const titles = await page.locator("#list .title").allTextContents();
    expect(titles).toContain("hostname-default.example");
  });

  test("invalid URL shows inline error, modal stays open", async ({ page }) => {
    await openAddModal(page);
    await page.locator("#m-url").fill("not a url");
    await page.keyboard.press("Enter");
    // Modal stays
    await expect(page.locator(".modal-overlay")).toBeVisible();
    // Error visible
    const err = page.locator("#m-error");
    await expect(err).toBeVisible();
    const errText = (await err.textContent()) ?? "";
    expect(errText.toLowerCase()).toContain("url");
  });

  test("'e' in normal mode opens Edit modal pre-filled from the selected row", async ({
    page,
  }) => {
    // Reveal at least one row.
    await page.locator("#q").fill("github");
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length > 0
    );
    const expectedTitle = await page
      .locator('#list li[aria-selected="true"] .title')
      .textContent();
    expect(expectedTitle).toBeTruthy();

    // Esc → e → Edit modal should open with the title field pre-populated.
    await page.keyboard.press("Escape");
    await page.keyboard.press("e");
    await expect(page.locator(".modal-overlay")).toBeVisible();
    await expect(page.locator(".modal h2 span").first()).toHaveText(
      "Edit bookmark"
    );
    await expect(page.locator("#m-title")).toHaveValue(expectedTitle!);
  });

  test("'dd' chord in normal mode deletes the selected row", async ({
    page,
  }) => {
    // Need a selected row to delete — type to reveal one.
    await page.locator("#q").fill("e");
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length > 0
    );
    const beforeCount = await page.locator("#list li").count();
    const id = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");
    expect(id).toBeTruthy();

    // Drop into normal mode and fire `d` `d` as a chord.
    await page.keyboard.press("Escape");
    await expect(page.locator("#picker")).toHaveAttribute(
      "data-mode",
      "normal"
    );

    const deletePromise = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/bookmarks/${id}`) &&
        r.request().method() === "DELETE"
    );
    await page.keyboard.press("d");
    await page.keyboard.press("d");
    const delResp = await deletePromise;
    expect(delResp.status()).toBe(204);

    // Row gone, list count decreased.
    await expect(page.locator(`#list li[data-id="${id}"]`)).toHaveCount(0);
    await expect(page.locator("#list li")).toHaveCount(beforeCount - 1);
  });
});
