import { test, expect } from "@playwright/test";

test("@smoke picker loads, filters, and exposes accessible selection", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#count")).not.toHaveText("");

  const query = page.getByRole("combobox", { name: "Search bookmarks" });
  await query.fill("github");
  await expect(page.getByRole("option").first()).toBeVisible();
  await expect(query).toHaveAttribute("aria-expanded", "true");
  await expect(query).toHaveAttribute("aria-activedescendant", /bookmark-option-/);
  await expect(page.locator(".app-version")).toHaveText(/^version \S+$/);
});

test("@smoke pointer hover selects and click opens a bookmark", async ({ page }) => {
  await page.route("**/go/*", (route) => route.fulfill({ status: 204 }));
  await page.goto("/");

  const query = page.getByRole("combobox", { name: "Search bookmarks" });
  await query.fill("e");
  const options = page.getByRole("option");
  await expect(options.nth(1)).toBeVisible();

  const hovered = options.nth(1);
  const id = await hovered.getAttribute("data-id");
  expect(id).toBeTruthy();
  await hovered.hover();

  await expect(hovered).toHaveAttribute("aria-selected", "true");
  await expect(options.first()).toHaveAttribute("aria-selected", "false");
  await expect(query).toHaveAttribute(
    "aria-activedescendant",
    `bookmark-option-${id}`,
  );

  const request = page.waitForRequest((candidate) =>
    candidate.url().includes(`/go/${id}`),
  );
  await hovered.click();
  await request;
});

test("@smoke manage loads and filters without mutating data", async ({ page }) => {
  await page.goto("/manage");
  await expect(page.locator("#rows tr").first()).toBeVisible();

  await page.getByRole("textbox", { name: "Filter bookmarks" }).fill("github");
  await expect
    .poll(() => page.locator("#rows tr:not([hidden])").count())
    .toBeGreaterThan(0);
  await expect(page.locator("#row-count")).toContainText("/");
});
