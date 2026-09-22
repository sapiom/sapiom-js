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


/** A folder that is NOTHING yet in the mock filesystem: no agent, no session,
 *  no `recentDirs` entry. The browser host's folder step lands on it. */
export const BLANK_PROJECT_ROOT = "/Users/demo/blank-slate";

/**
 * ADD PROJECT on the browser host (flow-creation.md §4.5): the header's
 * folder-plus opens the one-field folder dialog (there is no OS picker in
 * Playwright), the folder is typed, and the dialog's one action opens it as a
 * project. Nothing follows: no screen, no session.
 */
export async function addProject(page: Page, root: string): Promise<void> {
  await page.getByTestId("rail-add-project").click();
  await expect(page.getByTestId("project-folder-dialog")).toBeVisible();
  await page.getByTestId("folder-field-input").fill(root);
  await expect(page.getByTestId("project-folder-continue")).toBeEnabled();
  await page.getByTestId("project-folder-continue").click();
  await expect(page.getByTestId("project-folder-dialog")).toHaveCount(0);
}

/**
 * NEW PROJECT on the browser host (flow-creation.md §4.1): the rail's one CTA
 * runs the folder step, the folder opens as a project, and the new-agent
 * screen opens scoped to it. On desktop the OS picker replaces the dialog;
 * `folder-step.test.ts` proves that half.
 */
export async function openNewAgentScreen(
  page: Page,
  root: string = BLANK_PROJECT_ROOT,
): Promise<void> {
  await page.getByTestId("rail-new-project").click();
  await expect(page.getByTestId("project-folder-dialog")).toBeVisible();
  await page.getByTestId("folder-field-input").fill(root);
  await expect(page.getByTestId("project-folder-continue")).toBeEnabled();
  await page.getByTestId("project-folder-continue").click();
  await expect(page.getByTestId("new-session-composer")).toBeVisible();
}

/**
 * NEW AGENT in a project you already have (§4.2, D33, D34): the row's
 * hover-revealed `+` lands on the same screen, scoped to that project.
 */
export async function openNewAgentInProject(
  page: Page,
  label: string,
): Promise<void> {
  await page.getByTestId(`project-create-agent-${label}`).click();
  await expect(page.getByTestId("new-session-composer")).toBeVisible();
  await expect(page.getByTestId("new-agent-project")).toContainText(label);
}
