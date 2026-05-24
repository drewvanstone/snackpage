import { test, expect } from "@playwright/test";

// Pull the "N" out of a "K / N" count-text string. The list total grows when
// other tests add bookmarks in parallel, so tests that care about the delta
// should poll this rather than asserting a fixed value.
function parseTotal(text: string | null | undefined): number {
  const m = (text ?? "").match(/\/\s*(\d+)/);
  return m ? parseInt(m[1], 10) : NaN;
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

  test("Cmd+I opens Add modal with URL field focused", async ({ page }) => {
    await page.keyboard.press("Meta+i");
    await expect(page.locator(".modal-overlay")).toBeVisible();
    const focusedId = await page.evaluate(
      () => document.activeElement?.id ?? ""
    );
    expect(focusedId).toBe("m-url");
  });

  test("Esc inside modal cancels (no list change)", async ({ page }) => {
    const beforeCount = await page.locator("#list li").count();
    await page.keyboard.press("Meta+i");
    await expect(page.locator(".modal-overlay")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".modal-overlay")).toHaveCount(0);
    const afterCount = await page.locator("#list li").count();
    expect(afterCount).toBe(beforeCount);
  });

  test("Enter with valid URL submits and adds to list", async ({ page }) => {
    // Capture the bookmarks-loaded total before the add. Empty input renders
    // 0 rows so we read it from the right side of "0 / N" in the count text.
    const before = parseTotal(await page.locator("#count").textContent());
    await page.keyboard.press("Meta+i");
    await expect(page.locator(".modal-overlay")).toBeVisible();
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
    await page.keyboard.press("Meta+i");
    await expect(page.locator(".modal-overlay")).toBeVisible();
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
    await page.keyboard.press("Meta+i");
    await expect(page.locator(".modal-overlay")).toBeVisible();
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

  test("Cmd+D arms delete (red row); second Cmd+D within 2s deletes", async ({
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
    const row = page.locator(`#list li[data-id="${id}"]`);

    // First Cmd+D: arm delete. Check the class is applied synchronously.
    await page.keyboard.press("Meta+d");
    const armed = await row.evaluate((el) => el.classList.contains("deleting"));
    expect(armed).toBe(true);

    // Wait for the DELETE response before checking the list.
    const deletePromise = page.waitForResponse(
      (r) => r.url().includes(`/api/bookmarks/${id}`) && r.request().method() === "DELETE"
    );
    // Second Cmd+D: confirm delete
    await page.keyboard.press("Meta+d");
    const delResp = await deletePromise;
    expect(delResp.status()).toBe(204);

    // Row gone, list count decreased
    await expect(page.locator(`#list li[data-id="${id}"]`)).toHaveCount(0);
    await expect(page.locator("#list li")).toHaveCount(beforeCount - 1);
  });
});
