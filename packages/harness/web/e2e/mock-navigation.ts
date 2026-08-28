import { expect, type Page } from "@playwright/test";

/**
 * A project whose root is also an agent has one rail row, and that row IS the
 * agent: clicking it focuses the agent.
 *
 * This helper used to be called `focusRfqAgent`, and the
 * name was the defect's own fingerprint. The row's click used to belong to the
 * Project axis unconditionally, so it opened a dependency graph that had
 * exactly one node in it, and the only way to reach the agent was to click that
 * node. Eleven specs went the long way round, which is how a user-visible bug
 * ("I have to click that in order to see my agent") sat behind a green suite:
 * the detour had been written into the fixture's own vocabulary.
 *
 * The graph is still one click away, on the row's own map control.
 */
export async function focusRfqAgent(page: Page): Promise<void> {
  const row = page.getByTestId("workflow-rfq");
  await expect(row).toBeVisible();
  await row.locator(".workspace-row-main").click();
  await expect(row).toHaveClass(/is-focused/);
}

/** Bare-project labels now open graphs, so live sessions remain reachable through the finder. */
export async function selectMockSessionFromPalette(
  page: Page,
  name: string,
): Promise<void> {
  await page.getByTestId("palette-trigger").click();
  await page.getByTestId("command-palette-filter-sessions").click();
  await page.getByTestId("command-palette-input").fill(name);
  const item = page
    .locator(".command-palette-item")
    .filter({ hasText: name })
    .first();
  await expect(item).toBeVisible();
  await item.click();
}
