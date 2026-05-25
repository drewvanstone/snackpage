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

// ---------------------------------------------------------------------------
// Phase B — vim-modal keymap
// ---------------------------------------------------------------------------

test.describe("snackpage /manage — Phase B vim-modal keymap", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/manage");
    await page.waitForFunction(
      () => document.querySelectorAll("#rows tr").length > 0,
      null,
      { timeout: 5_000 },
    );
    await page.locator("#filter").focus();
  });

  test("initial mode is insert (filter focused, root data-mode=insert)", async ({ page }) => {
    const root = page.locator("#manage");
    await expect(root).toHaveAttribute("data-mode", "insert");
    const focusedId = await page.evaluate(
      () => document.activeElement?.id ?? "",
    );
    expect(focusedId).toBe("filter");
  });

  test("Esc inside a cell reverts and enters normal mode", async ({ page }) => {
    const id = await pickFirstRowId(page);
    const cell = page.locator(
      `#rows tr[data-id="${id}"] input[data-field="title"]`,
    );
    await cell.focus();
    const originalValue = await cell.inputValue();
    await cell.fill("bogus-temp-should-not-stick");
    await cell.press("Escape");

    await expect(cell).toHaveValue(originalValue);
    await expect(page.locator("#manage")).toHaveAttribute(
      "data-mode",
      "normal",
    );
  });

  test("j / k move the row cursor in normal mode", async ({ page }) => {
    // Drop into normal mode by blurring the filter via Esc.
    await page.keyboard.press("Escape");
    await expect(page.locator("#manage")).toHaveAttribute(
      "data-mode",
      "normal",
    );

    const startId = await page
      .locator('#rows tr[data-current="true"]')
      .getAttribute("data-id");
    await page.keyboard.press("j");
    const afterJ = await page
      .locator('#rows tr[data-current="true"]')
      .getAttribute("data-id");
    expect(afterJ).not.toBe(startId);

    await page.keyboard.press("k");
    const afterK = await page
      .locator('#rows tr[data-current="true"]')
      .getAttribute("data-id");
    expect(afterK).toBe(startId);
  });

  test("h / l move the column cursor", async ({ page }) => {
    await page.keyboard.press("Escape");
    // Start cursor should be at col 0.
    let colIdx = await page
      .locator('#rows tr[data-current="true"] td.cell[data-current="true"]')
      .getAttribute("data-col-index");
    expect(colIdx).toBe("0");

    await page.keyboard.press("l");
    colIdx = await page
      .locator('#rows tr[data-current="true"] td.cell[data-current="true"]')
      .getAttribute("data-col-index");
    expect(colIdx).toBe("1");

    await page.keyboard.press("l");
    colIdx = await page
      .locator('#rows tr[data-current="true"] td.cell[data-current="true"]')
      .getAttribute("data-col-index");
    expect(colIdx).toBe("2");

    await page.keyboard.press("h");
    colIdx = await page
      .locator('#rows tr[data-current="true"] td.cell[data-current="true"]')
      .getAttribute("data-col-index");
    expect(colIdx).toBe("1");

    // Clamp left at 0.
    await page.keyboard.press("h");
    await page.keyboard.press("h");
    await page.keyboard.press("h");
    colIdx = await page
      .locator('#rows tr[data-current="true"] td.cell[data-current="true"]')
      .getAttribute("data-col-index");
    expect(colIdx).toBe("0");
  });

  test("gg jumps to first row, G to last row", async ({ page }) => {
    await page.keyboard.press("Escape");
    const totalRows = await page.locator("#rows tr").count();
    expect(totalRows).toBeGreaterThan(2);

    // Advance a few rows.
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await page.keyboard.press("j");

    // G → last row.
    await page.keyboard.press("Shift+g");
    const lastIdx = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#rows tr")] as HTMLElement[];
      const visible = rows.filter((r) => r.style.display !== "none");
      return visible.findIndex(
        (r) => r.getAttribute("data-current") === "true",
      );
    });
    const visibleCount = await page.evaluate(
      () =>
        [...document.querySelectorAll("#rows tr")].filter(
          (r) => (r as HTMLElement).style.display !== "none",
        ).length,
    );
    expect(lastIdx).toBe(visibleCount - 1);

    // gg → first row.
    await page.keyboard.press("g");
    await page.keyboard.press("g");
    const firstIdx = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#rows tr")] as HTMLElement[];
      const visible = rows.filter((r) => r.style.display !== "none");
      return visible.findIndex(
        (r) => r.getAttribute("data-current") === "true",
      );
    });
    expect(firstIdx).toBe(0);
  });

  test("Ctrl+D / Ctrl+U half-page scroll (both modes)", async ({ page }) => {
    // Need lots of rows so the table actually scrolls.
    const total = await page.locator("#rows tr").count();
    expect(total).toBeGreaterThan(20);

    await page.keyboard.press("Escape");
    await expect(page.locator("#manage")).toHaveAttribute(
      "data-mode",
      "normal",
    );

    // Press Ctrl+D → cursor advances by halfPage rows.
    const halfPage = await page.evaluate(() => {
      const wrap = document.querySelector(".manage-table-wrap") as HTMLElement;
      const firstRow = document.querySelector("#rows tr") as HTMLElement;
      return Math.max(
        1,
        Math.floor(wrap.clientHeight / firstRow.offsetHeight / 2),
      );
    });
    expect(halfPage).toBeGreaterThan(1);

    await page.keyboard.press("Control+d");
    let idx = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#rows tr")] as HTMLElement[];
      const visible = rows.filter((r) => r.style.display !== "none");
      return visible.findIndex(
        (r) => r.getAttribute("data-current") === "true",
      );
    });
    expect(idx).toBe(halfPage);

    // Ctrl+U → back up.
    await page.keyboard.press("Control+u");
    idx = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#rows tr")] as HTMLElement[];
      const visible = rows.filter((r) => r.style.display !== "none");
      return visible.findIndex(
        (r) => r.getAttribute("data-current") === "true",
      );
    });
    expect(idx).toBe(0);
  });

  test("Enter in normal mode focuses current cell (insert mode)", async ({ page }) => {
    await page.keyboard.press("Escape");
    await expect(page.locator("#manage")).toHaveAttribute(
      "data-mode",
      "normal",
    );

    // l so we know we're targeting col 1 (URL).
    await page.keyboard.press("l");
    await page.keyboard.press("Enter");

    await expect(page.locator("#manage")).toHaveAttribute(
      "data-mode",
      "insert",
    );
    const focusedField = await page.evaluate(
      () => (document.activeElement as HTMLInputElement)?.dataset.field ?? "",
    );
    expect(focusedField).toBe("url");
  });

  test("a focuses current cell with cursor at end", async ({ page }) => {
    await page.keyboard.press("Escape");
    await page.keyboard.press("a");

    await expect(page.locator("#manage")).toHaveAttribute(
      "data-mode",
      "insert",
    );
    const result = await page.evaluate(() => {
      const el = document.activeElement as HTMLInputElement | null;
      if (!el) return null;
      return {
        valueLength: el.value.length,
        selStart: el.selectionStart,
        selEnd: el.selectionEnd,
        field: el.dataset.field,
      };
    });
    expect(result).not.toBeNull();
    expect(result!.field).toBe("title");
    expect(result!.selStart).toBe(result!.valueLength);
    expect(result!.selEnd).toBe(result!.valueLength);
  });

  test("o inserts a draft row below the current row and focuses title", async ({
    page,
  }) => {
    await page.keyboard.press("Escape");
    const beforeCount = await page.locator("#rows tr").count();

    // Record the id of the current row so we can verify the new draft sits
    // immediately after it.
    const currentId = await page
      .locator('#rows tr[data-current="true"]')
      .getAttribute("data-id");
    expect(currentId).toBeTruthy();

    await page.keyboard.press("o");

    const afterCount = await page.locator("#rows tr").count();
    expect(afterCount).toBe(beforeCount + 1);

    // The new draft is the current row, has no data-id, and the next sibling
    // of the previously-current row.
    const draftIsCurrent = await page.evaluate((prevId) => {
      const prev = document.querySelector(`#rows tr[data-id="${prevId}"]`);
      const draft = prev?.nextElementSibling as HTMLElement | null;
      return Boolean(
        draft &&
          !draft.dataset.id &&
          draft.getAttribute("data-current") === "true",
      );
    }, currentId);
    expect(draftIsCurrent).toBe(true);

    // Focus is on the draft's title input.
    const focusedField = await page.evaluate(
      () => (document.activeElement as HTMLInputElement)?.dataset.field ?? "",
    );
    expect(focusedField).toBe("title");
    await expect(page.locator("#manage")).toHaveAttribute(
      "data-mode",
      "insert",
    );
  });

  test("O inserts a draft row above the current row", async ({ page }) => {
    await page.keyboard.press("Escape");

    // Move down one so "above" inserts between rows (not at very top).
    await page.keyboard.press("j");
    const beforeCount = await page.locator("#rows tr").count();
    const currentId = await page
      .locator('#rows tr[data-current="true"]')
      .getAttribute("data-id");
    expect(currentId).toBeTruthy();

    await page.keyboard.press("Shift+o");

    const afterCount = await page.locator("#rows tr").count();
    expect(afterCount).toBe(beforeCount + 1);

    // The new draft is now the current row and is the previous sibling of
    // what was current.
    const draftIsCurrent = await page.evaluate((prevId) => {
      const prev = document.querySelector(`#rows tr[data-id="${prevId}"]`);
      const draft = prev?.previousElementSibling as HTMLElement | null;
      return Boolean(
        draft &&
          !draft.dataset.id &&
          draft.getAttribute("data-current") === "true",
      );
    }, currentId);
    expect(draftIsCurrent).toBe(true);

    const focusedField = await page.evaluate(
      () => (document.activeElement as HTMLInputElement)?.dataset.field ?? "",
    );
    expect(focusedField).toBe("title");
  });

  test("dd deletes the current row in normal mode", async ({ page }) => {
    await page.keyboard.press("Escape");

    const before = await fetchBookmarkCount(page);
    const targetId = await page
      .locator('#rows tr[data-current="true"]')
      .getAttribute("data-id");
    expect(targetId).toBeTruthy();

    const deletePromise = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/bookmarks/${targetId}`) &&
        r.request().method() === "DELETE",
    );
    await page.keyboard.press("d");
    await page.keyboard.press("d");
    const resp = await deletePromise;
    expect(resp.status()).toBe(204);

    await expect(
      page.locator(`#rows tr[data-id="${targetId}"]`),
    ).toHaveCount(0);
    const after = await fetchBookmarkCount(page);
    expect(after).toBe(before - 1);
  });

  test("/ focuses filter and enters insert mode", async ({ page }) => {
    await page.keyboard.press("Escape");
    await expect(page.locator("#manage")).toHaveAttribute(
      "data-mode",
      "normal",
    );

    await page.keyboard.press("/");

    const focusedId = await page.evaluate(
      () => document.activeElement?.id ?? "",
    );
    expect(focusedId).toBe("filter");
    await expect(page.locator("#manage")).toHaveAttribute(
      "data-mode",
      "insert",
    );
  });

  test("? opens help overlay; Esc closes it", async ({ page }) => {
    await page.keyboard.press("Escape");
    await expect(page.locator("#manage")).toHaveAttribute(
      "data-mode",
      "normal",
    );

    await page.keyboard.press("Shift+/");
    const overlay = page.locator(".modal-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText("Normal mode");
    await expect(overlay).toContainText("dd");
    await expect(overlay).toContainText("gg");

    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
  });

  test("chord timeout cancels pending sequence", async ({ page }) => {
    await page.keyboard.press("Escape");
    // Move a few rows down so we have a known starting row.
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    const beforeId = await page
      .locator('#rows tr[data-current="true"]')
      .getAttribute("data-id");

    // Press `g` — buffer arms (prefix of "gg"), no action.
    await page.keyboard.press("g");
    await page.waitForTimeout(700); // past CHORD_TIMEOUT_MS=500

    // Lone `g` again should NOT fire gg (chord buffer was cleared by timeout).
    await page.keyboard.press("g");
    const afterId = await page
      .locator('#rows tr[data-current="true"]')
      .getAttribute("data-id");
    expect(afterId).toBe(beforeId);
  });

  test("footer hints change with mode", async ({ page }) => {
    const hints = page.locator("#hints");
    const insertText = (await hints.textContent()) ?? "";
    expect(insertText).toContain("Tab nav");
    expect(insertText).not.toContain("hjkl");

    await page.keyboard.press("Escape");
    const normalText = (await hints.textContent()) ?? "";
    expect(normalText).toContain("hjkl");
    expect(normalText).toContain("dd delete");
    expect(normalText).toContain("o/O");
  });

  // ---------------------------------------------------------------------------
  // v1.5.2 — vim `u` undo (manage). Each test creates its own bookmark via the
  // API with a unique tag so it doesn't depend on other tests. Assertions go
  // through /api/bookmarks rather than scanning the rendered table to avoid
  // filter-state / row-ordering coupling.
  // ---------------------------------------------------------------------------

  test("u undoes a dd delete in manage", async ({ page, request }) => {
    const tag = "manage-undo-delete-" + Date.now();
    const create = await request.post("/api/bookmarks", {
      data: {
        title: "M-Delete-Test",
        url: "https://example.com/m-delete-" + Date.now(),
        tags: [tag],
      },
    });
    expect(create.ok()).toBeTruthy();
    const created = await create.json();

    await page.goto("/manage");
    await page.waitForSelector(`tr[data-id="${created.id}"]`);

    // Click the target row's title cell, then Esc → revert + normal mode.
    await page
      .locator(`tr[data-id="${created.id}"] input[data-field="title"]`)
      .click();
    await page.keyboard.press("Escape");

    // dd → delete current row.
    await page.keyboard.press("d");
    await page.keyboard.press("d");
    await page.waitForFunction(
      (id) => !document.querySelector(`tr[data-id="${id}"]`),
      created.id,
    );

    // u → undo (POSTs the snapshot back; new bookmark with same tag, new id).
    await page.keyboard.press("u");

    await page.waitForFunction(async (t) => {
      const r = await fetch("/api/bookmarks");
      const j = await r.json();
      return (j.bookmarks || []).some((b) => (b.tags || []).includes(t));
    }, tag);

    // Cleanup: find the restored bookmark by tag and delete it.
    const list = await (await request.get("/api/bookmarks")).json();
    const restored = (list.bookmarks || []).find((b) =>
      (b.tags || []).includes(tag),
    );
    if (restored) await request.delete("/api/bookmarks/" + restored.id);
  });

  test("u undoes a cell edit in manage", async ({ page, request }) => {
    const tag = "manage-undo-edit-" + Date.now();
    const create = await request.post("/api/bookmarks", {
      data: {
        title: "M-Edit-Before",
        url: "https://example.com/m-edit-" + Date.now(),
        tags: [tag],
      },
    });
    expect(create.ok()).toBeTruthy();
    const created = await create.json();

    await page.goto("/manage");
    await page.waitForSelector(`tr[data-id="${created.id}"]`);

    // Focus the title cell, change the value, Tab to commit via blur.
    const titleInput = page.locator(
      `tr[data-id="${created.id}"] input[data-field="title"]`,
    );
    await titleInput.click();
    await titleInput.fill("M-Edit-After");
    await page.keyboard.press("Tab");

    // Wait for the PUT round-trip to land.
    await page.waitForFunction(async (id) => {
      const r = await fetch("/api/bookmarks");
      const j = await r.json();
      return (
        (j.bookmarks || []).find((b) => b.id === id)?.title === "M-Edit-After"
      );
    }, created.id);

    // Esc out of insert (Tab moved focus to the url cell), then u → undo.
    await page.keyboard.press("Escape");
    await page.keyboard.press("u");

    // Title should be reverted to "M-Edit-Before".
    await page.waitForFunction(async (id) => {
      const r = await fetch("/api/bookmarks");
      const j = await r.json();
      return (
        (j.bookmarks || []).find((b) => b.id === id)?.title === "M-Edit-Before"
      );
    }, created.id);

    // Cleanup
    await request.delete("/api/bookmarks/" + created.id);
  });

  test("u undoes an o insert in manage", async ({ page, request }) => {
    await page.goto("/manage");
    await page.waitForSelector("tr[data-id]");

    const uniqueTag = "manage-undo-add-" + Date.now();
    const uniqueUrl = "https://example.com/m-add-" + Date.now();

    // Need to be on a row to use `o`. Focus an existing row's title cell,
    // then Esc → revert + normal mode.
    await page.locator("tr[data-id] input[data-field='title']").first().click();
    await page.keyboard.press("Escape");

    // `o` inserts a draft row below the current row and focuses its title.
    await page.keyboard.press("o");

    // Sanity: focus moved to a draft row's title input (no data-id on row).
    await page.waitForFunction(() => {
      const el = document.activeElement as HTMLInputElement | null;
      if (!el || el.dataset.field !== "title") return false;
      const tr = el.closest("tr") as HTMLElement | null;
      return Boolean(tr && !tr.dataset.id);
    });

    // Identify the draft row (the one containing the focused title input).
    const draftRow = page.locator("tr:not([data-id])").last();

    // Fill the fields. Order matters: fill tags BEFORE url so the url blur is
    // what triggers the POST (which happens on the first blur where both
    // title and url are non-empty). At that blur, readRowPayload(tr) snapshots
    // ALL inputs in the row including tags.
    await page.keyboard.type("M-Add-Test"); // title (already focused after `o`)
    await draftRow.locator("input[data-field='tags']").fill(uniqueTag);
    await draftRow.locator("input[data-field='url']").fill(uniqueUrl);
    // Blur the url input to commit the POST.
    await page.keyboard.press("Tab");

    // Wait for the new bookmark with our unique tag to land server-side.
    await page.waitForFunction(async (t) => {
      const r = await fetch("/api/bookmarks");
      const j = await r.json();
      return (j.bookmarks || []).some((b) => (b.tags || []).includes(t));
    }, uniqueTag);

    // Esc out of insert mode (Tab left focus on the tags input), then u.
    await page.keyboard.press("Escape");
    await page.keyboard.press("u");

    // Bookmark with our tag should be gone.
    await page.waitForFunction(async (t) => {
      const r = await fetch("/api/bookmarks");
      const j = await r.json();
      return !(j.bookmarks || []).some((b) => (b.tags || []).includes(t));
    }, uniqueTag);
  });

  test("<Space>p in normal mode jumps to picker (/)", async ({ page }) => {
    // Enter normal mode (filter is focused on load).
    await page.keyboard.press("Escape");
    await expect(page.locator(".manage-page")).toHaveAttribute("data-mode", "normal");

    // Leader chord: Space then p.
    await page.keyboard.press("Space");
    await page.keyboard.press("p");

    await page.waitForURL((url) => url.pathname === "/");
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("Cmd+click on a URL cell opens it in a new tab and does NOT focus the cell", async ({
    page,
    request,
  }) => {
    const tag = "cmdclick-" + Date.now();
    const targetUrl = "https://example.com/cmdclick-target";
    const create = await request.post("/api/bookmarks", {
      data: { title: "CmdClick", url: targetUrl, tags: [tag] },
    });
    const created = await create.json();

    await page.goto("/manage");
    await page.waitForSelector(`tr[data-id="${created.id}"]`);

    // Monkey-patch window.open so we can detect the call without spawning a
    // real tab (and without waiting for example.com to load).
    await page.evaluate(() => {
      (window as any).__opened = null;
      window.open = (url: string, target: string) => {
        (window as any).__opened = { url, target };
        return null as any;
      };
    });

    const urlCell = page.locator(
      `tr[data-id="${created.id}"] input[data-field="url"]`
    );
    await urlCell.click({ modifiers: ["Meta"] });

    const opened = await page.evaluate(() => (window as any).__opened);
    expect(opened).not.toBeNull();
    expect(opened.url).toBe(targetUrl);
    expect(opened.target).toBe("_blank");

    // Focus should NOT have moved to the URL cell.
    const focusedField = await page.evaluate(
      () => (document.activeElement as HTMLInputElement | null)?.dataset?.field ?? ""
    );
    expect(focusedField).not.toBe("url");

    // Cleanup
    await request.delete(`/api/bookmarks/${created.id}`);
  });
});
