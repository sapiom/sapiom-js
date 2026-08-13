/**
 * Command-palette search quality — the fixes for the 2026-08-11 report
 * ("cannot find this simple agent"). Runs against `?mockFixtures=search`,
 * which additively seeds the reported shapes: a scoped agent name, an agent
 * whose PATH carries the query's letters scattered across segments,
 * duplicate same-title history rows, and a raw-first-prompt title.
 */
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/?mockFixtures=search");
  await expect(page.locator(".rail-workflows")).toBeVisible();
});

test("an agent is found by its display name, not its raw scoped package name", async ({ page }) => {
  await page.getByTestId("palette-trigger").click();
  await page.getByTestId("command-palette-input").fill("slack");

  // "@sapiom/example-slack-notifier" surfaces as "slack-notifier", with the
  // match highlighted in the NAME, and ranks first.
  const first = page.getByTestId("command-palette-item-0");
  await expect(first.locator(".command-palette-item-label")).toHaveText("slack-notifier");
  await expect(first.locator(".command-palette-item-label .palette-match").first()).toBeVisible();

  // The scatter-path foil (s…l…a…c…k strewn across "social…analytics-stack")
  // no longer matches at all.
  await expect(page.getByTestId("command-palette-list")).not.toContainText("daily-activity-analyst");
});

test("an agent name outranks history noise instead of drowning under it", async ({ page }) => {
  await page.getByTestId("palette-trigger").click();
  await page.getByTestId("command-palette-input").fill("daily");

  const first = page.getByTestId("command-palette-item-0");
  await expect(first).toContainText("daily-activity-analyst");
  // And the raw-prompt noise rows ("You are annotating…") stay out entirely.
  await expect(page.getByTestId("command-palette-list")).not.toContainText("You are annotating");
});

test("indistinguishable past sessions collapse to a single row", async ({ page }) => {
  await page.getByTestId("palette-trigger").click();
  await page.getByTestId("command-palette-input").fill("Standup");

  const list = page.getByTestId("command-palette-list");
  await expect(list.getByText("Standup summary for #eng")).toHaveCount(1);
});

test("a renamed session is searchable by its new name", async ({ page }) => {
  // Same rename flow the header test uses (client-side ui-prefs persistence).
  await page.getByTestId("session-menu").click();
  await page.getByTestId("session-rename").click();
  const input = page.getByTestId("session-rename-input");
  await input.fill("Leasing revamp");
  await input.press("Enter");
  await expect(page.getByTestId("session-context-title")).toHaveText("Leasing revamp");

  await page.getByTestId("palette-trigger").click();
  await page.getByTestId("command-palette-input").fill("revamp");
  const first = page.getByTestId("command-palette-item-0");
  await expect(first).toContainText("Leasing revamp");
  await expect(first.locator(".command-palette-item-label .palette-match").first()).toBeVisible();
});

test("the current session is badged, and never the default selection", async ({ page }) => {
  await page.getByTestId("palette-trigger").click();
  const list = page.getByTestId("command-palette-list");

  // The active (boot) session carries the "current" pill…
  const currentRow = list.locator(".command-palette-item.is-current");
  await expect(currentRow).toHaveCount(1);
  await expect(currentRow.locator(".command-palette-current")).toHaveText("current");

  // …and the default-selected row is the first ranked item that is NOT it.
  const selected = list.locator(".command-palette-item.is-selected");
  await expect(selected).toHaveCount(1);
  await expect(selected).not.toHaveClass(/is-current/);
});

test("jump targets show their raw path as monospace meta", async ({ page }) => {
  await page.getByTestId("palette-trigger").click();

  const first = page.getByTestId("command-palette-item-0");
  const meta = first.locator(".command-palette-item-meta");
  await expect(meta).toContainText("/Users/demo/acme-app");
  await expect(meta).toHaveAttribute("data-code", "true");
});

test("the Actions tab lists the app's verbs, and Enter runs one", async ({ page }) => {
  await page.getByTestId("palette-trigger").click();
  await page.getByTestId("command-palette-filter-actions").click();

  const list = page.getByTestId("command-palette-list");
  for (const label of [
    "Browse templates",
    "Toggle theme",
    "Hide workspace panel",
    "Hide canvas panel",
    "New session in this folder",
  ]) {
    await expect(list.getByText(label)).toBeVisible();
  }

  // Running "Hide workspace panel" collapses the rail.
  await list.getByText("Hide workspace panel").click();
  await expect(page.locator(".rail-workflows")).toBeHidden();
});

test("the Docs tab searches the doc links and offers the docs site in the footer", async ({ page }) => {
  await page.getByTestId("palette-trigger").click();
  await page.getByTestId("command-palette-filter-docs").click();

  const list = page.getByTestId("command-palette-list");
  await expect(list.getByText("Agents quick start")).toBeVisible();
  await expect(page.getByTestId("command-palette-destination")).toContainText("Open documentation");

  await page.getByTestId("command-palette-input").fill("mcp");
  await expect(list.getByText("MCP servers: setup")).toBeVisible();
  await expect(list.getByText("Agents quick start")).toBeHidden();
});

test("a scoped tab never leaks other kinds into the results", async ({ page }) => {
  await page.getByTestId("palette-trigger").click();
  await page.getByTestId("command-palette-filter-files").click();

  const sections = page.getByTestId("command-palette-section");
  await expect(sections).toHaveCount(1);
  await expect(sections.first()).toHaveText("Folders");
});

test("Escape clears a typed query first and closes only when empty", async ({ page }) => {
  await page.getByTestId("palette-trigger").click();
  const input = page.getByTestId("command-palette-input");
  await input.fill("leasing");

  await page.keyboard.press("Escape");
  await expect(input).toHaveValue("");
  await expect(page.getByTestId("command-palette-list")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-palette-list")).toBeHidden();
});

test("the Templates tab lists the catalog and its footer link opens the gallery", async ({ page }) => {
  await page.getByTestId("palette-trigger").click();
  await page.getByTestId("command-palette-filter-templates").click();

  // The catalog itself is listed (gallery fixtures + bundled starters) …
  const list = page.getByTestId("command-palette-list");
  await expect(list.getByText("Hello Agent")).toBeVisible();

  // … and the browse link lives in the footer, not as a lone action row.
  await expect(list.getByText("Browse templates")).toHaveCount(0);
  const destination = page.getByTestId("command-palette-destination");
  await expect(destination).toContainText("Browse templates");
  await destination.click();
  await expect(page.locator(".templates-panel")).toBeVisible();
});

test("activating a template opens the gallery focused on it", async ({ page }) => {
  await page.getByTestId("palette-trigger").click();
  await page.getByTestId("command-palette-input").fill("Hello Agent");
  await expect(page.getByTestId("command-palette-item-0")).toContainText("Hello Agent");
  await page.keyboard.press("Enter");

  await expect(page.locator(".templates-panel")).toBeVisible();
  await expect(page.locator(".template-detail")).toContainText("Hello Agent");
});

test("Tab and Shift+Tab cycle the category tabs", async ({ page }) => {
  await page.getByTestId("palette-trigger").click();

  await page.keyboard.press("Tab");
  await expect(page.getByTestId("command-palette-filter-sessions")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("command-palette-filter-all")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("command-palette-filter-actions")).toHaveAttribute("aria-selected", "true");

  // A typed query never blocks it, and focus stays in the input.
  await page.getByTestId("command-palette-filter-all").click();
  await page.getByTestId("command-palette-input").fill("leasing");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("command-palette-filter-sessions")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("command-palette-input")).toBeFocused();

  // The footer hints the binding.
  await expect(page.getByTestId("command-palette-footer")).toContainText("category");
});

test("the Sessions and Agents tabs scope their kinds", async ({ page }) => {
  await page.getByTestId("palette-trigger").click();

  await page.getByTestId("command-palette-filter-sessions").click();
  const sections = page.getByTestId("command-palette-section");
  await expect(sections.first()).toHaveText("Sessions");
  await expect(sections.filter({ hasText: "Agents" })).toHaveCount(0);

  await page.getByTestId("command-palette-filter-agents").click();
  await expect(sections).toHaveCount(1);
  await expect(sections.first()).toHaveText("Agents");
  await expect(page.getByTestId("command-palette-list")).toContainText("slack-notifier");
});

test("the filter row hides in path mode and the footer shows the shortcut hint", async ({ page }) => {
  await page.getByTestId("palette-trigger").click();
  await expect(page.getByTestId("command-palette-filter-all")).toBeVisible();
  await expect(page.getByTestId("command-palette-footer")).toContainText("navigate");

  await page.getByTestId("command-palette-input").fill("/Users/demo");
  await expect(page.getByTestId("command-palette-filter-all")).toBeHidden();
  await expect(page.getByText("Open this path")).toBeVisible();
});
