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
    const beforeCount = await page.locator("#list li[data-id]").count();
    await openAddModal(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".modal-overlay")).toHaveCount(0);
    const afterCount = await page.locator("#list li[data-id]").count();
    expect(afterCount).toBe(beforeCount);
  });

  test("Enter with valid URL submits and adds to list", async ({
    page,
    request,
  }) => {
    // Capture the bookmarks-loaded total before the add. Empty input renders
    // 0 rows so we read it from the right side of "0 / N" in the count text.
    const before = parseTotal(await page.locator("#count").textContent());
    const stamp = Date.now();
    let createdId = "";

    try {
      await openAddModal(page);
      await page.locator("#m-url").fill(`https://modal-add-${stamp}.example`);
      await page.locator("#m-title").fill(`Example Test Bookmark ${stamp}`);
      const postPromise = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/bookmarks") &&
          response.request().method() === "POST",
      );
      await page.keyboard.press("Enter");
      const postResponse = await postPromise;
      expect(postResponse.ok()).toBeTruthy();
      createdId = (await postResponse.json()).id;

      await expect(page.locator(".modal-overlay")).toHaveCount(0);
      await expect
        .poll(async () => parseTotal(await page.locator("#count").textContent()))
        .toBe(before + 1);
      await page.locator("#q").fill(`Example Test Bookmark ${stamp}`);
      await expect(page.locator(`#list li[data-id="${createdId}"]`)).toBeVisible();
    } finally {
      if (createdId) await request.delete(`/api/bookmarks/${createdId}`);
    }
  });

  test("blank title defaults to URL hostname on submit", async ({
    page,
    request,
  }) => {
    const before = parseTotal(await page.locator("#count").textContent());
    const stamp = Date.now();
    const hostname = `hostname-default-${stamp}.example`;
    let createdId = "";

    try {
      await openAddModal(page);
      await page.locator("#m-url").fill(`https://${hostname}/path`);
      await page.locator("#m-title").fill("");
      const postPromise = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/bookmarks") &&
          response.request().method() === "POST",
      );
      await page.keyboard.press("Enter");
      const postResponse = await postPromise;
      expect(postResponse.ok()).toBeTruthy();
      createdId = (await postResponse.json()).id;

      await expect(page.locator(".modal-overlay")).toHaveCount(0);
      await expect
        .poll(async () => parseTotal(await page.locator("#count").textContent()))
        .toBe(before + 1);
      await page.locator("#q").fill(hostname);
      await expect(page.locator(`#list li[data-id="${createdId}"] .title`))
        .toHaveText(hostname);
    } finally {
      if (createdId) await request.delete(`/api/bookmarks/${createdId}`);
    }
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

  test("save is single-flight and normalizes a bare URL", async ({
    page,
    request,
  }) => {
    const suffix = Date.now();
    const title = `Single Flight ${suffix}`;
    let posts = 0;
    await page.route("**/api/bookmarks", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      posts += 1;
      await new Promise((resolve) => setTimeout(resolve, 250));
      const response = await route.fetch();
      await route.fulfill({ response });
    });

    await openAddModal(page);
    await page.locator("#m-url").fill(`single-flight-${suffix}.example/path`);
    await page.locator("#m-title").fill(title);
    await page.evaluate(() => {
      const save = document.getElementById("m-save") as HTMLButtonElement;
      save.click();
      save.click();
    });

    await page.keyboard.press("Escape");
    await expect(page.locator(".modal-overlay")).toBeVisible();
    await expect(page.locator(".modal-overlay")).toHaveCount(0);
    await expect
      .poll(async () => {
        const response = await request.get("/api/bookmarks");
        const body = await response.json();
        return body.bookmarks.find((bookmark) => bookmark.title === title);
      })
      .not.toBeUndefined();
    expect(posts).toBe(1);

    const response = await request.get("/api/bookmarks");
    const body = await response.json();
    const bookmark = body.bookmarks.find((candidate) => candidate.title === title);
    expect(bookmark.url).toBe(`https://single-flight-${suffix}.example/path`);
    await page.unroute("**/api/bookmarks");
    await request.delete(`/api/bookmarks/${bookmark.id}`);
  });

  test("a malformed success response is surfaced as an unknown outcome", async ({
    page,
    request,
  }) => {
    const suffix = Date.now();
    const title = `Unknown Outcome ${suffix}`;
    let posts = 0;
    await page.route("**/api/bookmarks", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      posts += 1;
      await route.fetch();
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: "{}",
      });
    });

    await openAddModal(page);
    await page.locator("#m-url").fill(`https://unknown-${suffix}.example`);
    await page.locator("#m-title").fill(title);
    await page.locator("#m-save").click();

    await expect(page.locator(".modal-overlay")).toBeVisible();
    await expect(page.locator("#m-error")).toContainText("Outcome unknown");
    await expect(page.locator("#m-save")).toBeDisabled();
    await page.locator("#m-save").evaluate((button: HTMLButtonElement) => button.click());
    expect(posts).toBe(1);
    await page.keyboard.press("Escape");
    await page.keyboard.press("a");
    await expect(page.locator(".modal-overlay")).toHaveCount(0);
    await expect(page.locator("#status")).toContainText("reload");

    const response = await request.get("/api/bookmarks");
    const body = await response.json();
    const bookmark = body.bookmarks.find((candidate) => candidate.title === title);
    expect(bookmark).toBeTruthy();
    await page.unroute("**/api/bookmarks");
    await request.delete(`/api/bookmarks/${bookmark.id}`);
  });

  test("a mutation transport failure blocks retries until reload", async ({
    page,
  }) => {
    await page.route("**/api/bookmarks", async (route) => {
      if (route.request().method() === "POST") {
        await route.abort("connectionfailed");
      } else {
        await route.continue();
      }
    });

    await openAddModal(page);
    await page.locator("#m-url").fill("https://transport-failure.example");
    await page.locator("#m-title").fill("Transport failure");
    await page.locator("#m-save").click();

    await expect(page.locator("#m-error")).toContainText("Outcome unknown");
    await expect(page.locator("#m-save")).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.keyboard.press("a");
    await expect(page.locator(".modal-overlay")).toHaveCount(0);
    await expect(page.locator("#status")).toContainText("reload");
  });

  test("'e' in normal mode opens Edit modal pre-filled from the selected row", async ({
    page,
  }) => {
    // Reveal at least one row.
    await page.locator("#q").fill("github");
    await page.waitForFunction(
      () => document.querySelectorAll("#list li[data-id]").length > 0
    );
    const expectedTitle = await page
      .locator('#list li[data-id][aria-selected="true"] .title')
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
    request,
  }) => {
    const stamp = Date.now();
    const title = `Modal Delete Fixture ${stamp}`;
    const create = await request.post("/api/bookmarks", {
      data: {
        title,
        url: `https://modal-delete-${stamp}.example`,
      },
    });
    expect(create.ok()).toBeTruthy();
    const owned = await create.json();

    try {
      await page.goto("/");
      await page.locator("#q").fill(title);
      const selected = page.locator(
        '#list li[data-id][aria-selected="true"]',
      );
      await expect(selected).toHaveAttribute("data-id", owned.id);
      const beforeCount = await page.locator("#list li[data-id]").count();

      // Drop into normal mode and fire `d` `d` as a chord.
      await page.keyboard.press("Escape");
      await expect(page.locator("#picker")).toHaveAttribute(
        "data-mode",
        "normal"
      );

      const deletePromise = page.waitForResponse(
        (response) =>
          response.url().includes(`/api/bookmarks/${owned.id}`) &&
          response.request().method() === "DELETE"
      );
      await page.keyboard.press("d");
      await page.keyboard.press("d");
      const deleteResponse = await deletePromise;
      expect(deleteResponse.status()).toBe(204);

      await expect(page.locator(`#list li[data-id="${owned.id}"]`)).toHaveCount(0);
      await expect(page.locator("#list li[data-id]")).toHaveCount(
        beforeCount - 1,
      );
    } finally {
      await request.delete(`/api/bookmarks/${owned.id}`);
    }
  });
});
