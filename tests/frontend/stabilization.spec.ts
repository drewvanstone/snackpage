import { test, expect } from "@playwright/test";

async function waitForPickerLoad(page) {
  await page.waitForFunction(
    () => document.getElementById("count")?.textContent !== "",
  );
}

async function waitForManageLoad(page) {
  await page.waitForFunction(
    () => document.querySelectorAll("#rows tr[data-id]").length > 0,
  );
}

test.describe("frontend stabilization edges", () => {
  test("picker does not open a mutation modal during an active delete", async ({
    page,
    request,
  }) => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const createdResponse = await request.post("/api/bookmarks", {
      data: {
        title: `Picker gate ${suffix}`,
        url: `https://picker-gate-${suffix}.example`,
      },
    });
    const created = await createdResponse.json();

    let releaseDelete = () => {};
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let markDeleteStarted = () => {};
    const deleteStarted = new Promise<void>((resolve) => {
      markDeleteStarted = resolve;
    });

    await page.route(`**/api/bookmarks/${created.id}`, async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.continue();
        return;
      }
      markDeleteStarted();
      await deleteGate;
      await route.fulfill({ response: await route.fetch() });
    });

    try {
      await page.goto("/");
      await waitForPickerLoad(page);
      await page.locator("#q").fill(created.title);
      await page.keyboard.press("Escape");
      await page.keyboard.press("d");
      await page.keyboard.press("d");
      await deleteStarted;

      await page.keyboard.press("a");
      await expect(page.locator(".modal-overlay")).toHaveCount(0);

      releaseDelete();
      await expect(
        page.locator(`#list li[data-id="${created.id}"]`),
      ).toHaveCount(0);
      await page.keyboard.press("a");
      await expect(page.locator(".modal-overlay")).toBeVisible();
      await page.keyboard.press("Escape");
    } finally {
      releaseDelete();
      await request.delete(`/api/bookmarks/${created.id}`);
    }
  });

  test("manage locks mutation controls during delete, then resumes saves", async ({
    page,
    request,
  }) => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const deleteResponse = await request.post("/api/bookmarks", {
      data: {
        title: `Delete gate ${suffix}`,
        url: `https://delete-gate-${suffix}.example`,
      },
    });
    const editResponse = await request.post("/api/bookmarks", {
      data: {
        title: `Edit gate ${suffix}`,
        url: `https://edit-gate-${suffix}.example`,
      },
    });
    const deleteTarget = await deleteResponse.json();
    const editTarget = await editResponse.json();

    let releaseDelete = () => {};
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let markDeleteStarted = () => {};
    const deleteStarted = new Promise<void>((resolve) => {
      markDeleteStarted = resolve;
    });
    let activeRequests = 0;
    let maxActiveRequests = 0;
    let puts = 0;

    await page.route(`**/api/bookmarks/${deleteTarget.id}`, async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.continue();
        return;
      }
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      markDeleteStarted();
      await deleteGate;
      const response = await route.fetch();
      activeRequests -= 1;
      await route.fulfill({ response });
    });
    await page.route(`**/api/bookmarks/${editTarget.id}`, async (route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      puts += 1;
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      const response = await route.fetch();
      activeRequests -= 1;
      await route.fulfill({ response });
    });

    try {
      await page.goto("/manage");
      await waitForManageLoad(page);
      await page
        .locator(
          `tr[data-id="${deleteTarget.id}"] input[data-field="title"]`,
        )
        .focus();
      await page.keyboard.press("Escape");
      await page.keyboard.press("d");
      await page.keyboard.press("d");
      await deleteStarted;

      const draftsBefore = await page.locator("#rows tr:not([data-id])").count();
      await expect(page.locator("#add-btn")).toBeDisabled();
      await expect(page.locator("#rows tr:not([data-id])")).toHaveCount(
        draftsBefore,
      );

      const newTitle = `Edited after delete ${suffix}`;
      const titleInput = page.locator(
        `tr[data-id="${editTarget.id}"] input[data-field="title"]`,
      );
      await expect(titleInput).toHaveAttribute("readonly", "");
      expect(puts).toBe(0);

      releaseDelete();
      await expect(titleInput).not.toHaveAttribute("readonly", "");
      await titleInput.fill(newTitle);
      await page.locator("#filter").focus();
      await expect
        .poll(async () => {
          const response = await request.get("/api/bookmarks");
          const body = await response.json();
          return body.bookmarks.find(
            (bookmark) => bookmark.id === editTarget.id,
          )?.title;
        })
        .toBe(newTitle);
      expect(puts).toBe(1);
      expect(maxActiveRequests).toBe(1);
    } finally {
      releaseDelete();
      await request.delete(`/api/bookmarks/${deleteTarget.id}`);
      await request.delete(`/api/bookmarks/${editTarget.id}`);
    }
  });

  test("manage keeps controls locked through an undo reload", async ({
    page,
    request,
  }) => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const originalTitle = `Undo lock ${suffix}`;
    const undoSourceResponse = await request.post("/api/bookmarks", {
      data: {
        title: originalTitle,
        url: `https://undo-lock-${suffix}.example`,
      },
    });
    const otherResponse = await request.post("/api/bookmarks", {
      data: {
        title: `Undo lock other ${suffix}`,
        url: `https://undo-lock-other-${suffix}.example`,
      },
    });
    const undoSource = await undoSourceResponse.json();
    const other = await otherResponse.json();

    let releaseUndo = () => {};
    const undoGate = new Promise<void>((resolve) => {
      releaseUndo = resolve;
    });
    let markUndoStarted = () => {};
    const undoStarted = new Promise<void>((resolve) => {
      markUndoStarted = resolve;
    });

    try {
      await page.goto("/manage");
      await waitForManageLoad(page);
      const title = page.locator(
        `tr[data-id="${undoSource.id}"] input[data-field="title"]`,
      );
      const initialSave = page.waitForResponse(
        (response) =>
          response.url().includes(`/api/bookmarks/${undoSource.id}`) &&
          response.request().method() === "PUT",
      );
      await title.fill(`Changed before undo ${suffix}`);
      await page.locator("#filter").focus();
      await initialSave;

      await page.route(`**/api/bookmarks/${undoSource.id}`, async (route) => {
        if (route.request().method() !== "PUT") {
          await route.continue();
          return;
        }
        markUndoStarted();
        await undoGate;
        await route.fulfill({ response: await route.fetch() });
      });

      await page.keyboard.press("Escape");
      await page.keyboard.press("u");
      await undoStarted;
      await expect(page.locator("#add-btn")).toBeDisabled();
      await expect(
        page.locator(
          `tr[data-id="${other.id}"] input[data-field="title"]`,
        ),
      ).toHaveAttribute("readonly", "");

      releaseUndo();
      await expect(
        page.locator(
          `tr[data-id="${undoSource.id}"] input[data-field="title"]`,
        ),
      ).toHaveValue(originalTitle);
      await expect(page.locator("#add-btn")).toBeEnabled();
      await expect(
        page.locator(
          `tr[data-id="${other.id}"] input[data-field="title"]`,
        ),
      ).not.toHaveAttribute("readonly", "");
    } finally {
      releaseUndo();
      await request.delete(`/api/bookmarks/${undoSource.id}`);
      await request.delete(`/api/bookmarks/${other.id}`);
    }
  });

  test("a failed mouse delete is disarmed and needs fresh confirmation", async ({
    page,
    request,
  }) => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const createdResponse = await request.post("/api/bookmarks", {
      data: {
        title: `Delete failure ${suffix}`,
        url: `https://delete-failure-${suffix}.example`,
      },
    });
    const created = await createdResponse.json();
    let deletes = 0;

    await page.route(`**/api/bookmarks/${created.id}`, async (route) => {
      if (route.request().method() !== "DELETE") {
        await route.continue();
        return;
      }
      deletes += 1;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "known test failure" }),
      });
    });

    try {
      await page.goto("/manage");
      await waitForManageLoad(page);
      const row = page.locator(`tr[data-id="${created.id}"]`);
      const button = row.locator(".del-btn");
      // Keep the normal-mode cursor on this owned row when button focus blurs
      // the autofocus filter; otherwise renderCursor scrolls back to row zero
      // between mousedown and click for a row near the end of the table.
      await row.locator('input[data-field="title"]').focus();
      await button.click();
      await expect(row).toHaveClass(/deleting/);
      await button.click();
      await expect(page.locator("#status")).toContainText("known test failure");
      await expect(row).not.toHaveClass(/deleting/);

      await button.click();
      await expect(row).toHaveClass(/deleting/);
      expect(deletes).toBe(1);
    } finally {
      await request.delete(`/api/bookmarks/${created.id}`);
    }
  });

  test("startup mode follows real focus when autofocus is unavailable", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const originalFocus = HTMLElement.prototype.focus;
      const suppressOnce = new Set(["q", "filter"]);
      HTMLElement.prototype.focus = function (options?: FocusOptions) {
        if (suppressOnce.delete(this.id)) return;
        originalFocus.call(this, options);
      };
    });
    await page.route("**/*", async (route) => {
      if (
        route.request().resourceType() !== "document" ||
        !["/", "/manage"].includes(new URL(route.request().url()).pathname)
      ) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = (await response.text()).replace(/\sautofocus(?=[\s>])/g, "");
      await route.fulfill({ response, body });
    });

    await page.goto("/");
    await waitForPickerLoad(page);
    await expect(page.locator("#picker")).toHaveAttribute(
      "data-mode",
      "normal",
    );
    await page.keyboard.press("i");
    await expect(page.locator("#q")).toBeFocused();
    await expect(page.locator("#picker")).toHaveAttribute(
      "data-mode",
      "insert",
    );

    await page.goto("/manage");
    await waitForManageLoad(page);
    await expect(page.locator("#manage")).toHaveAttribute(
      "data-mode",
      "normal",
    );
    await page.keyboard.press("/");
    await expect(page.locator("#filter")).toBeFocused();
    await expect(page.locator("#manage")).toHaveAttribute(
      "data-mode",
      "insert",
    );
  });

  test("themes still bootstrap and apply when localStorage throws", async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    await page.addInitScript(() => {
      for (const method of ["getItem", "setItem", "removeItem"] as const) {
        Object.defineProperty(Storage.prototype, method, {
          configurable: true,
          value() {
            throw new DOMException("storage disabled", "SecurityError");
          },
        });
      }
    });

    await page.goto("/?theme=classic-mac");
    await waitForPickerLoad(page);
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "classic-mac",
    );
    await expect(page.locator("#theme-css")).toHaveAttribute(
      "href",
      /classic-mac\.css/,
    );

    await page.locator("#q").focus();
    await page.keyboard.press("Escape");
    await page.keyboard.press(" ");
    await page.keyboard.press("t");
    await page.locator("#theme-q").fill("dracula");
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "dracula",
    );
    await expect(page.locator("#theme-css")).toHaveAttribute(
      "href",
      /dracula\.css/,
    );
    expect(pageErrors).toEqual([]);
  });
});
