import { test, expect } from "@playwright/test";

// Fetch /api/bookmarks and return the entry for `id` (or undefined). Used to
// verify that PUT/POST/DELETE actually round-tripped to the store, rather than
// just trusting the DOM.
async function fetchBookmark(page, id: string) {
  return page.evaluate(async (lookupId) => {
    const r = await fetch("/api/bookmarks");
    const j = await r.json();
    return (j.bookmarks || []).find((b) => b.id === lookupId);
  }, id);
}

async function fetchBookmarkCount(page): Promise<number> {
  return page.evaluate(async () => {
    const r = await fetch("/api/bookmarks");
    const j = await r.json();
    return (j.bookmarks || []).length;
  });
}

// Pick an arbitrary existing row's data-id. Tests that need to edit/delete a
// specific row use this so they don't depend on row ordering between runs.
async function pickFirstRowId(page): Promise<string> {
  const id = await page
    .locator("#rows tr[data-id]")
    .first()
    .getAttribute("data-id");
  if (!id) throw new Error("no rows with data-id found");
  return id;
}

test.describe("snackpage /manage — Phase A spreadsheet view", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/manage");
    // Wait for /api/bookmarks to populate the table — rendering happens after
    // an async fetch, so #rows is empty for one tick.
    await page.waitForFunction(
      () => document.querySelectorAll("#rows tr").length > 0,
      null,
      { timeout: 5_000 },
    );
    // Headless Chromium doesn't always honor autofocus reliably; mirror the
    // picker tests by focusing the filter input explicitly so the first
    // tab-stop test is deterministic.
    await page.locator("#filter").focus();
  });

  test("/manage renders all bookmarks as rows", async ({ page }) => {
    const rows = await page.locator("#rows tr").count();
    expect(rows).toBe(100);
  });

  test("filter input is the first tab-stop", async ({ page }) => {
    // Reset focus to the document root, then Tab and observe where focus lands.
    // Setting tabIndex=-1 on documentElement makes it focusable so we can blur
    // off whatever was focused by beforeEach. (body.focus() doesn't reliably
    // remove focus from a previously focused element in headless Chromium.)
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      document.documentElement.tabIndex = -1;
      document.documentElement.focus();
    });
    await page.keyboard.press("Tab");
    const focusedId = await page.evaluate(
      () => document.activeElement?.id ?? "",
    );
    expect(focusedId).toBe("filter");
  });

  test("filter narrows visible rows by title match", async ({ page }) => {
    await page.locator("#filter").fill("github");
    // Filter is synchronous on input — but allow one tick for fzf.
    await page.waitForFunction(() => {
      const all = [...document.querySelectorAll("#rows tr")];
      const visible = all.filter((tr) => (tr as HTMLElement).style.display !== "none");
      return visible.length > 0 && visible.length < all.length;
    });
    const visibleTitles = await page.evaluate(() => {
      const trs = [...document.querySelectorAll("#rows tr")] as HTMLElement[];
      return trs
        .filter((tr) => tr.style.display !== "none")
        .map(
          (tr) =>
            (tr.querySelector('input[data-field="title"]') as HTMLInputElement)
              ?.value ?? "",
        );
    });
    expect(visibleTitles.length).toBeGreaterThan(0);
    expect(visibleTitles.length).toBeLessThan(100);
    expect(
      visibleTitles.some((t) => t.toLowerCase().includes("github")),
    ).toBeTruthy();
  });

  test("filter narrows visible rows by tag match", async ({ page }) => {
    await page.locator("#filter").fill("shopping");
    await page.waitForFunction(() => {
      const all = [...document.querySelectorAll("#rows tr")];
      const visible = all.filter((tr) => (tr as HTMLElement).style.display !== "none");
      return visible.length > 0 && visible.length < all.length;
    });
    const visibleTitles = await page.evaluate(() => {
      const trs = [...document.querySelectorAll("#rows tr")] as HTMLElement[];
      return trs
        .filter((tr) => tr.style.display !== "none")
        .map(
          (tr) =>
            (
              tr.querySelector('input[data-field="title"]') as HTMLInputElement
            )?.value.toLowerCase() ?? "",
        );
    });
    expect(visibleTitles.length).toBeGreaterThan(0);
    // Demo data has Amazon, eBay, Etsy, Walmart, Target tagged "shopping".
    expect(
      visibleTitles.some((t) =>
        ["amazon", "ebay", "etsy", "walmart", "target"].includes(t),
      ),
    ).toBeTruthy();
  });

  test("clearing filter restores all rows visible", async ({ page }) => {
    // Snapshot the total before filtering. The server is shared across the
    // full Playwright run, so previous tests (modal add, dd-delete, etc.)
    // can shift the count off 100 — we just need "after clear == before
    // filter" for whatever the total currently is.
    const totalBefore = await page.locator("#rows tr").count();
    expect(totalBefore).toBeGreaterThan(0);

    await page.locator("#filter").fill("github");
    await page.waitForFunction(() => {
      const all = [...document.querySelectorAll("#rows tr")];
      const visible = all.filter(
        (tr) => (tr as HTMLElement).style.display !== "none",
      );
      return visible.length > 0 && visible.length < all.length;
    });
    await page.locator("#filter").fill("");
    await page.waitForFunction((expected: number) => {
      const all = [...document.querySelectorAll("#rows tr")];
      const visible = all.filter(
        (tr) => (tr as HTMLElement).style.display !== "none",
      );
      return visible.length === expected;
    }, totalBefore);
    const visible = await page.evaluate(() => {
      const trs = [...document.querySelectorAll("#rows tr")] as HTMLElement[];
      return trs.filter((tr) => tr.style.display !== "none").length;
    });
    expect(visible).toBe(totalBefore);
  });

  test("editing a title cell + blur saves via PUT", async ({ page }) => {
    const id = await pickFirstRowId(page);
    const newTitle = `pw-edited-${Date.now()}`;

    const cell = page.locator(
      `#rows tr[data-id="${id}"] input[data-field="title"]`,
    );
    await cell.focus();
    await cell.fill(newTitle);

    // Wait for the PUT round-trip triggered by blur.
    const putPromise = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/bookmarks/${id}`) &&
        r.request().method() === "PUT",
    );
    await page.keyboard.press("Tab");
    const putResp = await putPromise;
    expect(putResp.ok()).toBeTruthy();

    const stored = await fetchBookmark(page, id);
    expect(stored?.title).toBe(newTitle);
  });

  test("Esc reverts a cell without saving", async ({ page }) => {
    const id = await pickFirstRowId(page);
    const before = await fetchBookmark(page, id);
    const cell = page.locator(
      `#rows tr[data-id="${id}"] input[data-field="title"]`,
    );

    await cell.focus();
    const originalValue = await cell.inputValue();
    await cell.fill("bogus-temp-title-should-not-stick");
    await cell.press("Escape");

    // Cell DOM value reverted...
    await expect(cell).toHaveValue(originalValue);
    // ...and the server still holds the pre-edit title.
    const after = await fetchBookmark(page, id);
    expect(after?.title).toBe(before?.title);
  });

  test("invalid URL marks cell with .invalid and blocks save", async ({
    page,
  }) => {
    const id = await pickFirstRowId(page);
    const before = await fetchBookmark(page, id);
    const cell = page.locator(`#rows tr[data-id="${id}"] input[data-field="url"]`);

    await cell.focus();
    await cell.fill("not a url");
    // Blur via Tab — manage.js validates on blur and adds .invalid on failure.
    await page.keyboard.press("Tab");

    // The URL input gains .invalid and no successful PUT round-tripped.
    await expect(cell).toHaveClass(/invalid/);
    const after = await fetchBookmark(page, id);
    expect(after?.url).toBe(before?.url);
  });

  test("+ Add inserts a draft row at the top of the table", async ({
    page,
  }) => {
    const beforeRowCount = await page.locator("#rows tr").count();
    await page.locator("#add-btn").click();

    // New row inserted at index 0 with no data-id.
    const firstRow = page.locator("#rows tr").first();
    await expect(firstRow).not.toHaveAttribute("data-id", /.+/);
    // Title input should be empty in the draft.
    await expect(
      firstRow.locator('input[data-field="title"]'),
    ).toHaveValue("");
    // Total rows grew by 1.
    await expect(page.locator("#rows tr")).toHaveCount(beforeRowCount + 1);
    // Focus moved to the draft's title input per manage.js logic.
    const focusedField = await page.evaluate(
      () => (document.activeElement as HTMLInputElement)?.dataset.field ?? "",
    );
    expect(focusedField).toBe("title");
  });

  test("completing the draft row triggers POST", async ({ page }) => {
    const before = await fetchBookmarkCount(page);

    await page.locator("#add-btn").click();
    const draft = page.locator("#rows tr").first();
    const title = draft.locator('input[data-field="title"]');
    const url = draft.locator('input[data-field="url"]');

    const stamp = Date.now();
    await title.fill(`Playwright Draft ${stamp}`);
    await url.fill(`https://pw-draft-${stamp}.example`);

    const postPromise = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/bookmarks") && r.request().method() === "POST",
    );
    // Blur the url input to trigger the POST.
    await url.blur();
    const postResp = await postPromise;
    expect(postResp.ok()).toBeTruthy();

    const after = await fetchBookmarkCount(page);
    expect(after).toBe(before + 1);
    // The draft row now has a server-issued id.
    await expect(draft).toHaveAttribute("data-id", /.+/);
  });

  test("two-tap delete sends DELETE and removes the row", async ({ page }) => {
    const before = await fetchBookmarkCount(page);
    const id = await pickFirstRowId(page);

    const row = page.locator(`#rows tr[data-id="${id}"]`);
    const delBtn = row.locator(".del-btn");

    // First click: row is "armed" with the .deleting class — nothing
    // round-tripped yet.
    await delBtn.click();
    await expect(row).toHaveClass(/deleting/);
    expect(await fetchBookmarkCount(page)).toBe(before);

    // Second click within 2s: actual DELETE.
    const deletePromise = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/bookmarks/${id}`) &&
        r.request().method() === "DELETE",
    );
    await delBtn.click();
    const delResp = await deletePromise;
    expect(delResp.status()).toBe(204);

    await expect(page.locator(`#rows tr[data-id="${id}"]`)).toHaveCount(0);
    expect(await fetchBookmarkCount(page)).toBe(before - 1);
  });

  test("cross-link picker <-> manage navigates correctly", async ({ page }) => {
    // From /manage: "← picker" sends you home.
    await page.locator(".back-link").click();
    await page.waitForURL(/\/$/);
    expect(new URL(page.url()).pathname).toBe("/");

    // From /: picker footer's "manage" link sends you to /manage.
    await page.locator(".footer .cross-link").click();
    await page.waitForURL(/\/manage$/);
    expect(new URL(page.url()).pathname).toBe("/manage");
  });
});
