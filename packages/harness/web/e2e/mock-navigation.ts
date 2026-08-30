import { expect, type Page } from "@playwright/test";

/**
 * A project whose root is also an agent has one rail row, and that row IS the
 * agent: clicking it focuses the agent.
 *
 * This helper used to be called `focusRfqAgentThroughProjectGraph`,
 * and the name was the defect's own fingerprint. The row's click used to belong to the
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

/**
 * Open a project row's ⋮ menu.
 *
 * Every action a project row offers now lives behind one control (SAP-2982).
 * `+` and `×` used to sit on the row itself — adjacent, same size, same
 * hover-reveal — while acting on different nouns: `+` created an AGENT in the
 * project, `×` removed the PROJECT. A menu of named items has no adjacency to
 * misread, and the specs open it before acting.
 */
export async function openProjectMenu(page: Page, label: string): Promise<void> {
  await page.getByTestId(`project-menu-${label}`).click();
  await expect(page.getByTestId(`project-menu-card-${label}`)).toBeVisible();
}
