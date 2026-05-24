import { test, expect } from "@playwright/test";

test.describe("snackpage picker — modal flows", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length > 0,
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
    const beforeCount = await page.locator("#list li").count();
    await page.keyboard.press("Meta+i");
    await expect(page.locator(".modal-overlay")).toBeVisible();
    await page.locator("#m-url").fill("https://example.test/new-bookmark");
    await page.locator("#m-title").fill("Example Test Bookmark");
    await page.keyboard.press("Enter");
    // Modal should close
    await expect(page.locator(".modal-overlay")).toHaveCount(0);
    // List should have grown by 1
    await expect(page.locator("#list li")).toHaveCount(beforeCount + 1);
    // The new title should be visible
    const titles = await page.locator("#list .title").allTextContents();
    expect(titles).toContain("Example Test Bookmark");
  });

  test("blank title defaults to URL hostname on submit", async ({ page }) => {
    const beforeCount = await page.locator("#list li").count();
    await page.keyboard.press("Meta+i");
    await expect(page.locator(".modal-overlay")).toBeVisible();
    await page.locator("#m-url").fill("https://hostname-default.example/path");
    // leave title blank
    await page.locator("#m-title").fill("");
    await page.keyboard.press("Enter");
    await expect(page.locator(".modal-overlay")).toHaveCount(0);
    await expect(page.locator("#list li")).toHaveCount(beforeCount + 1);
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
