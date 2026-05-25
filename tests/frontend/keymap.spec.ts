import { test, expect } from "@playwright/test";

test.describe("snackpage picker — keymap and modes", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // List is empty by default — wait for the count text to populate as proof
    // that /api/bookmarks has loaded. Individual tests type to reveal rows.
    await page.waitForFunction(
      () => document.getElementById("count")?.textContent !== "",
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
    // `a` now opens the Add modal — exercise `/` instead (also a "back to
    // insert" binding) so this test stays scoped to mode-transition behavior.
    await page.keyboard.press("/");
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

    // Insert mode: should mention "⎋ normal" and the `?` help affordance
    const insertText = (await hints.textContent()) ?? "";
    expect(insertText).toContain("⎋ normal");
    expect(insertText).toContain("?");
    expect(insertText).not.toContain("j/k");

    await page.keyboard.press("Escape");

    // Normal mode: should mention "i insert", j/k, and the new chord vocabulary
    const normalText = (await hints.textContent()) ?? "";
    expect(normalText).toContain("i insert");
    expect(normalText).toContain("j/k");
    expect(normalText).toContain("a add");
    expect(normalText).toContain("e edit");
    expect(normalText).toContain("dd delete");
    expect(normalText).not.toContain("⎋ normal");
  });

  test("j/k navigates only in normal mode", async ({ page }) => {
    // Insert mode: typing "j" populates the input, not navigation.
    await page.keyboard.press("j");
    // Input should now contain "j"
    await expect(page.locator("#q")).toHaveValue("j");

    // Clear input, then prime with a query that yields multiple rows so
    // j/k has somewhere to navigate. Then drop into normal mode.
    await page.locator("#q").fill("e");
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length > 1
    );
    await page.keyboard.press("Escape");
    await expect(page.locator("#picker")).toHaveAttribute(
      "data-mode",
      "normal"
    );

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
  });

  test("arrow keys navigate in both modes", async ({ page }) => {
    // Prime the list with a multi-row result first.
    await page.locator("#q").fill("e");
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length > 1
    );

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
    // Prime the list with a multi-row result first.
    await page.locator("#q").fill("e");
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length > 1
    );

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

  test("Ctrl+D / Ctrl+U scroll half a page in both modes", async ({ page }) => {
    // Prime list with a multi-row result that exceeds the visible area.
    await page.locator("#q").fill("e");
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length > 20
    );

    // Compute expected half-page step from DOM measurements (matches the
    // pageScroll() formula in app.js).
    const halfPage = await page.evaluate(() => {
      const list = document.getElementById("list");
      const firstRow = list.querySelector("li");
      return Math.max(
        1,
        Math.floor(list.clientHeight / firstRow.offsetHeight / 2)
      );
    });
    expect(halfPage).toBeGreaterThan(1);

    // Insert mode (input still focused): Ctrl+D moves selection down.
    await page.keyboard.press("Control+d");
    let idx = await page.evaluate(() =>
      [...document.querySelectorAll("#list li")].findIndex(
        (el) => el.getAttribute("aria-selected") === "true"
      )
    );
    expect(idx).toBe(halfPage);

    // Ctrl+U moves it back.
    await page.keyboard.press("Control+u");
    idx = await page.evaluate(() =>
      [...document.querySelectorAll("#list li")].findIndex(
        (el) => el.getAttribute("aria-selected") === "true"
      )
    );
    expect(idx).toBe(0);

    // Normal mode: same behavior.
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+d");
    idx = await page.evaluate(() =>
      [...document.querySelectorAll("#list li")].findIndex(
        (el) => el.getAttribute("aria-selected") === "true"
      )
    );
    expect(idx).toBe(halfPage);

    // Ctrl+D again: selection moves to 2× halfPage (clamped at last row).
    await page.keyboard.press("Control+d");
    idx = await page.evaluate(() =>
      [...document.querySelectorAll("#list li")].findIndex(
        (el) => el.getAttribute("aria-selected") === "true"
      )
    );
    const total = await page.locator("#list li").count();
    expect(idx).toBe(Math.min(total - 1, halfPage * 2));
  });

  test("gg jumps to top of list in normal mode", async ({ page }) => {
    // Prime the list with a multi-row result.
    await page.locator("#q").fill("e");
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length > 2
    );
    await page.keyboard.press("Escape");
    await expect(page.locator("#picker")).toHaveAttribute(
      "data-mode",
      "normal"
    );

    // Advance the selection a few rows so gg has somewhere to come back from.
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await page.keyboard.press("j");

    // Confirm we're not on row 0
    let selectedIdx = await page.evaluate(() => {
      const items = [...document.querySelectorAll("#list li")];
      return items.findIndex(
        (el) => el.getAttribute("aria-selected") === "true"
      );
    });
    expect(selectedIdx).toBeGreaterThan(0);

    // Two quick g presses → chord → nav-top.
    await page.keyboard.press("g");
    await page.keyboard.press("g");

    selectedIdx = await page.evaluate(() => {
      const items = [...document.querySelectorAll("#list li")];
      return items.findIndex(
        (el) => el.getAttribute("aria-selected") === "true"
      );
    });
    expect(selectedIdx).toBe(0);
  });

  test("G jumps to bottom of list in normal mode and scrolls it into view", async ({
    page,
  }) => {
    // Prime the list with a multi-row result that exceeds the list's
    // max-height (60vh) so a real scroll is required to see the bottom row.
    await page.locator("#q").fill("e");
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length > 20
    );
    await page.keyboard.press("Escape");

    const total = await page.locator("#list li").count();
    expect(total).toBeGreaterThan(20);

    // Before G: list is scrolled to the top.
    const scrollBefore = await page.evaluate(
      () => document.getElementById("list").scrollTop
    );
    expect(scrollBefore).toBe(0);

    // Shift+g → G → nav-bottom.
    await page.keyboard.press("Shift+g");

    const selectedIdx = await page.evaluate(() => {
      const items = [...document.querySelectorAll("#list li")];
      return items.findIndex(
        (el) => el.getAttribute("aria-selected") === "true"
      );
    });
    expect(selectedIdx).toBe(total - 1);

    // After G: the list must have scrolled down so the bottom row is visible.
    const scrollAfter = await page.evaluate(
      () => document.getElementById("list").scrollTop
    );
    expect(scrollAfter).toBeGreaterThan(0);

    // And gg should scroll back to the top.
    await page.keyboard.press("g");
    await page.keyboard.press("g");
    const scrollAfterTop = await page.evaluate(
      () => document.getElementById("list").scrollTop
    );
    expect(scrollAfterTop).toBe(0);
  });

  test("? opens the help overlay; Esc closes it", async ({ page }) => {
    await page.keyboard.press("Escape");
    await expect(page.locator("#picker")).toHaveAttribute(
      "data-mode",
      "normal"
    );
    // `?` is Shift+/
    await page.keyboard.press("Shift+/");
    const overlay = page.locator(".modal-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText("Keyboard shortcuts");
    // And the help content should mention the new chords.
    await expect(overlay).toContainText("dd");
    await expect(overlay).toContainText("gg");

    // Esc closes.
    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
  });

  test("chord timeout cancels pending sequence", async ({ page }) => {
    // Prime the list with multiple rows.
    await page.locator("#q").fill("e");
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length > 1
    );
    await page.keyboard.press("Escape");

    // Move selection a few rows down so we have an unambiguous starting point.
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    const beforeId = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");

    // Type "g" — this is a prefix (for "gg"), so the buffer arms but no
    // action runs.
    await page.keyboard.press("g");

    // Wait past the 500ms chord timeout so the buffer drops.
    await page.waitForTimeout(700);

    // Now type "g" again. With no pending buffer, a lone "g" has no exact
    // match (only "gg" is bound), and it IS a prefix again — so it should
    // re-arm but NOT trigger nav-top. Selection should not have changed.
    await page.keyboard.press("g");
    const afterId = await page
      .locator('#list li[aria-selected="true"]')
      .getAttribute("data-id");
    expect(afterId).toBe(beforeId);
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
    // Need rows to have something to open — type first.
    await page.locator("#q").fill("e");
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length > 0
    );
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

  // ---------------------------------------------------------------------------
  // v1.5.2 — vim `u` undo (picker). Each test creates its own bookmark via the
  // API with a unique tag so it doesn't depend on existing demo data or step on
  // other tests sharing the demo server. Assertions go through /api/bookmarks
  // rather than the rendered DOM to sidestep filter-state interaction.
  // ---------------------------------------------------------------------------

  test("u undoes a dd delete in picker", async ({ page, request }) => {
    const tag = "undo-delete-" + Date.now();
    const create = await request.post("/api/bookmarks", {
      data: {
        title: "U-Delete-Test",
        url: "https://example.com/u-delete-" + Date.now(),
        tags: [tag],
      },
    });
    expect(create.ok()).toBeTruthy();

    await page.goto("/");
    await page.locator("#q").focus();
    await page.locator("#q").fill(tag);
    await page.waitForFunction((t) => {
      return [...document.querySelectorAll("#list li")].some((li) =>
        li.querySelector(".sub")?.textContent?.includes(t),
      );
    }, tag);

    // Drop into normal mode, dd to delete; count should fall to 0 since only
    // our bookmark matches the query.
    await page.keyboard.press("Escape");
    await page.keyboard.press("d");
    await page.keyboard.press("d");
    await page.waitForFunction(
      () => document.querySelectorAll("#list li").length === 0,
    );

    // u → undo. POSTs the snapshot back; the new bookmark has the same tag
    // (and a NEW server-assigned id).
    await page.keyboard.press("u");

    await page.waitForFunction(async (t) => {
      const r = await fetch("/api/bookmarks");
      const j = await r.json();
      return (j.bookmarks || []).some((b) => (b.tags || []).includes(t));
    }, tag);

    // Cleanup: delete the restored bookmark by its new id.
    const list = await (await request.get("/api/bookmarks")).json();
    const restored = (list.bookmarks || []).find((b) =>
      (b.tags || []).includes(tag),
    );
    if (restored) await request.delete("/api/bookmarks/" + restored.id);
  });

  test("u undoes an edit (modal) in picker", async ({ page, request }) => {
    const tag = "undo-edit-" + Date.now();
    const create = await request.post("/api/bookmarks", {
      data: {
        title: "U-Edit-Before",
        url: "https://example.com/u-edit-" + Date.now(),
        tags: [tag],
      },
    });
    expect(create.ok()).toBeTruthy();
    const created = await create.json();

    await page.goto("/");
    await page.locator("#q").focus();
    await page.locator("#q").fill(tag);
    await page.waitForFunction((t) => {
      return [...document.querySelectorAll("#list li")].some((li) =>
        li.querySelector(".sub")?.textContent?.includes(t),
      );
    }, tag);

    // Open the edit modal, change the title, submit with Enter.
    await page.keyboard.press("Escape");
    await page.keyboard.press("e");
    await page.locator("#m-title").fill("U-Edit-After");
    await page.keyboard.press("Enter");

    // Wait for the PUT to land server-side.
    await page.waitForFunction(async (id) => {
      const r = await fetch("/api/bookmarks");
      const j = await r.json();
      return (
        (j.bookmarks || []).find((b) => b.id === id)?.title === "U-Edit-After"
      );
    }, created.id);

    // Close-modal re-focuses #q → insert mode; Escape back to normal, then u.
    await page.keyboard.press("Escape");
    await page.keyboard.press("u");

    // Title should be reverted to the pre-edit value.
    await page.waitForFunction(async (id) => {
      const r = await fetch("/api/bookmarks");
      const j = await r.json();
      return (
        (j.bookmarks || []).find((b) => b.id === id)?.title === "U-Edit-Before"
      );
    }, created.id);

    // Cleanup
    await request.delete("/api/bookmarks/" + created.id);
  });

  test("u undoes an add (modal) in picker", async ({ page, request }) => {
    const tag = "undo-add-" + Date.now();

    await page.goto("/");
    await page.locator("#q").focus();
    await page.keyboard.press("Escape");
    await page.keyboard.press("a");

    // Modal: fill the fields, Enter to submit.
    await page.locator("#m-url").fill("https://example.com/u-add-" + Date.now());
    await page.locator("#m-title").fill("U-Add-Test");
    await page.locator("#m-tags").fill(tag);
    await page.keyboard.press("Enter");

    // Wait for the POST to land — a bookmark with our tag should now exist.
    await page.waitForFunction(async (t) => {
      const r = await fetch("/api/bookmarks");
      const j = await r.json();
      return (j.bookmarks || []).some((b) => (b.tags || []).includes(t));
    }, tag);

    // closeModal() re-focuses #q (insert mode); Escape back to normal then u.
    await page.keyboard.press("Escape");
    await page.keyboard.press("u");

    // Bookmark should be gone.
    await page.waitForFunction(async (t) => {
      const r = await fetch("/api/bookmarks");
      const j = await r.json();
      return !(j.bookmarks || []).some((b) => (b.tags || []).includes(t));
    }, tag);
  });
});
