import { test, expect } from "@playwright/test";

function searchBookmark(
  id: string,
  title: string,
  url: string,
  tags: string[] = [],
  aliases: string[] = [],
) {
  return {
    id,
    title,
    url,
    tags,
    aliases,
    visit_count: 0,
    last_visit_at: null,
    frecency_score: 0,
  };
}

test("@smoke direct navigation focuses the bookmark search", async ({ page }) => {
  await page.goto("/");

  const query = page.getByRole("combobox", { name: "Search bookmarks" });
  await expect(query).toBeFocused();
  await expect(page.locator("#picker")).toHaveAttribute("data-mode", "insert");

  await page.keyboard.type("github");
  await expect(query).toHaveValue("github");
});

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
  const options = page.locator("#list li[data-id]");
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

test("@smoke search rejects scattered matches and keeps close fuzzy matches", async ({
  page,
}) => {
  const titleMatches = Array.from({ length: 16 }, (_, index) =>
    searchBookmark(
      `100000${String(index).padStart(2, "0")}`,
      `Mistral Project ${String(index + 1).padStart(2, "0")}`,
      `https://mistral-${index + 1}.example.test`,
    ),
  );
  const bookmarks = [
    ...titleMatches,
    searchBookmark(
      "20000001",
      "Team Runbook",
      "https://runbook.example.test",
      ["mistral"],
    ),
    searchBookmark(
      "20000002",
      "AI Workspace",
      "https://workspace.example.test",
      [],
      ["mistral"],
    ),
    searchBookmark(
      "20000003",
      "Vendor Portal",
      "https://mistral-console.example.test",
    ),
    searchBookmark(
      "30000001",
      "Management Infrastructure Portal",
      "https://docs.example.test/platform",
    ),
    searchBookmark(
      "30000002",
      "Learning Portal",
      "https://example.test/management/instructions/material",
    ),
    searchBookmark(
      "30000003",
      "NovaLearn",
      "https://novalearn.example.test",
    ),
    searchBookmark(
      "30000004",
      "People Portal",
      "https://nova.example.test/resources/Learning_Development",
    ),
    searchBookmark(
      "30000005",
      "Incident Briefing Queue",
      "https://interviews.example.test",
    ),
    searchBookmark(
      "30000006",
      "MCP Console",
      "https://mcp.example.test",
    ),
    searchBookmark(
      "30000007",
      "Metrics Control Plane",
      "https://metrics.example.test",
    ),
    searchBookmark(
      "30000008",
      "Release Archive",
      "https://docs.example.test/archive/release-notes-42",
    ),
    searchBookmark(
      "30000009",
      "Ops Console",
      "https://ops.example.test",
    ),
    searchBookmark(
      "30000010",
      "Service Dashboard",
      "https://service.example.test",
      ["operations"],
    ),
    searchBookmark(
      "30000011",
      "Operations Handbook",
      "https://handbook.example.test",
    ),
    searchBookmark(
      "30000012",
      "AI Console",
      "https://ai.example.test",
    ),
    searchBookmark(
      "30000013",
      "Platform Guide",
      "https://platform.example.test",
      ["architecture"],
    ),
    ...Array.from({ length: 16 }, (_, index) =>
      searchBookmark(
        `400000${String(index).padStart(2, "0")}`,
        `Example Filler ${String(index + 1).padStart(2, "0")}`,
        `https://filler-${index + 1}.example.test`,
      ),
    ),
  ];

  await page.route("**/api/bookmarks", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ bookmarks }),
    }),
  );
  await page.goto("/");

  const query = page.getByRole("combobox", { name: "Search bookmarks" });
  const allOptions = page.getByRole("option");
  const options = page.locator("#list li[data-id]");
  const titles = options.locator(".title");

  await query.fill("e");
  await expect(options).toHaveCount(bookmarks.length);
  await expect(allOptions).toHaveCount(bookmarks.length + 1);
  await expect(allOptions.last()).toHaveAttribute(
    "id",
    "web-search-option-google",
  );
  const oldScrollTop = await page.locator("#list").evaluate((list) => {
    list.scrollTop = list.scrollHeight;
    return list.scrollTop;
  });
  expect(oldScrollTop).toBeGreaterThan(0);

  await query.fill("mistral");
  await expect(options).toHaveCount(19);
  const orderedTitles = await titles.allTextContents();
  expect(orderedTitles[0]).toMatch(/^Mistral Project/);
  expect(orderedTitles.indexOf("AI Workspace")).toBeLessThan(
    orderedTitles.indexOf("Team Runbook"),
  );
  expect(orderedTitles.indexOf("Team Runbook")).toBeLessThan(
    orderedTitles.indexOf("Vendor Portal"),
  );
  await expect(titles.filter({ hasText: "Team Runbook" })).toHaveCount(1);
  await expect(titles.filter({ hasText: "AI Workspace" })).toHaveCount(1);
  await expect(titles.filter({ hasText: "Vendor Portal" })).toHaveCount(1);
  await expect(
    titles.filter({ hasText: "Infrastructure Portal" }),
  ).toHaveCount(0);
  await expect(titles.filter({ hasText: "Learning Portal" })).toHaveCount(0);
  await expect
    .poll(() => page.locator("#list").evaluate((list) => list.scrollTop))
    .toBe(0);

  await query.fill("MISTRAL");
  await expect(options).toHaveCount(19);

  await query.fill("mstral");
  await expect(options).toHaveCount(19);
  await expect(titles.filter({ hasText: "Team Runbook" })).toHaveCount(1);
  await expect(titles.filter({ hasText: "AI Workspace" })).toHaveCount(1);
  await expect(titles.filter({ hasText: "Vendor Portal" })).toHaveCount(1);

  await query.fill("novalearn");
  await expect(titles).toHaveText(["NovaLearn"]);

  await query.fill("novalern");
  await expect(titles).toHaveText(["NovaLearn"]);

  await query.fill("ibq");
  await expect(titles).toHaveText(["Incident Briefing Queue"]);

  await query.fill("mcp");
  await expect(titles).toHaveText(["MCP Console"]);

  await query.fill("ops");
  await expect(titles).toHaveText(["Ops Console", "Service Dashboard"]);

  await query.fill("ai");
  await expect(titles).toHaveCount(2);
  await expect(titles.filter({ hasText: "AI Console" })).toHaveCount(1);
  await expect(titles.filter({ hasText: "AI Workspace" })).toHaveCount(1);
  await expect(titles.filter({ hasText: "Platform Guide" })).toHaveCount(0);

  await query.fill("release-notes-42");
  await expect(titles).toHaveText(["Release Archive"]);
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
