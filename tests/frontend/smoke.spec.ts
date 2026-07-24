import { test, expect } from "@playwright/test";

test("@smoke picker loads, filters, and exposes accessible selection", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#count")).not.toHaveText("");

  const query = page.getByRole("combobox", { name: "Search bookmarks" });
  await query.fill("github");
  await expect(page.getByRole("option").first()).toBeVisible();
  await expect(query).toHaveAttribute("aria-expanded", "true");
  await expect(query).toHaveAttribute("aria-activedescendant", /bookmark-option-/);
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
